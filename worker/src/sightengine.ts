// Client de l'API de moderation Sightengine, cote videur.
//
// Le bucket R2 etant prive, on NE transmet jamais d'URL : on POUSSE le binaire du media (methode
// recommandee par Sightengine pour du contenu non public). Les images partent en multipart sur
// /1.0/check.json (verdict synchrone). Les videos passeront par l'Upload API + callback async
// (ajoute dans un second temps).
//
// Verdict normalise : { decision, topCategory, score, framesAnalyzed }. Une image = 1 frame = 1 op.

const API_BASE = 'https://api.sightengine.com/1.0'

// Modeles demandes (images ET frames video). nudity-2.1 = derniere version NSFW ; gore = violence ;
// offensive = symboles/gestes haineux. (weapon/wad volontairement non active : peu pertinent pour
// un site voyage/sport et generateur de faux positifs.)
const MODELS = 'nudity-2.1,gore,offensive'

export interface SightengineConfig {
  apiUser: string
  apiSecret: string
  /** Seuils de flag (0-1). Bas = flag large (on prefere un faux positif que l'admin leve vite). */
  nudityThreshold: number
  goreThreshold: number
  offensiveThreshold: number
}

export interface ModerationVerdict {
  decision: 'ok' | 'flag'
  /** Categorie la plus risquee, ex "nudity", "gore", "offensive". */
  topCategory: string
  /** Score de la categorie retenue (0-1). */
  score: number
  /** Nombre de frames analysees (1 pour une image) -> sert au compteur d'operations. */
  framesAnalyzed: number
}

export class SightengineError extends Error {}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

// Plus grande valeur numerique d'un objet (utilise pour `offensive`, dont les sous-classes varient
// selon la version du modele : on flague des qu'une sous-classe depasse le seuil).
const maxNumericValue = (value: unknown): number => {
  if (!value || typeof value !== 'object') return 0
  let max = 0
  for (const entry of Object.values(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) max = Math.max(max, entry)
    else if (entry && typeof entry === 'object') max = Math.max(max, maxNumericValue(entry))
  }
  return max
}

interface CategoryScore {
  category: string
  score: number
  threshold: number
}

// Construit le verdict a partir de la reponse image Sightengine.
const verdictFromImageResponse = (
  data: Record<string, unknown>,
  config: SightengineConfig,
): ModerationVerdict => {
  if (data.status && data.status !== 'success') {
    const error = data.error as { message?: string } | undefined
    throw new SightengineError(error?.message ?? 'Reponse Sightengine en erreur.')
  }

  const nudity = (data.nudity ?? {}) as Record<string, unknown>
  // On ne retient que le contenu sexuel EXPLICITE ; le "suggestif" (maillot, plage...) est tolere.
  const nudityScore = Math.max(
    num(nudity.sexual_activity),
    num(nudity.sexual_display),
    num(nudity.erotica),
    num(nudity.sextoy),
  )

  const categories: CategoryScore[] = [
    { category: 'nudity', score: nudityScore, threshold: config.nudityThreshold },
    {
      category: 'gore',
      score: num((data.gore as Record<string, unknown> | undefined)?.prob),
      threshold: config.goreThreshold,
    },
    {
      category: 'offensive',
      score: maxNumericValue(data.offensive),
      threshold: config.offensiveThreshold,
    },
  ]

  const flagged = categories.filter((entry) => entry.score >= entry.threshold)
  const pickHighest = (list: CategoryScore[]): CategoryScore =>
    list.reduce((best, entry) => (entry.score > best.score ? entry : best))

  const top = flagged.length ? pickHighest(flagged) : pickHighest(categories)
  return {
    decision: flagged.length ? 'flag' : 'ok',
    topCategory: top.category,
    score: top.score,
    framesAnalyzed: 1,
  }
}

/**
 * Modere une IMAGE en poussant son binaire a Sightengine (multipart, pas d'URL).
 * `bytes` = contenu du fichier (lu depuis le binding R2). Throw `SightengineError` en cas de panne
 * pour que l'appelant NE marque PAS le media comme scanne (re-tente au prochain passage).
 */
export const moderateImageBinary = async (
  bytes: ArrayBuffer,
  fileName: string,
  contentType: string,
  config: SightengineConfig,
): Promise<ModerationVerdict> => {
  const form = new FormData()
  form.append('models', MODELS)
  form.append('api_user', config.apiUser)
  form.append('api_secret', config.apiSecret)
  form.append('media', new Blob([bytes], { type: contentType }), fileName)

  let response: Response
  try {
    response = await fetch(`${API_BASE}/check.json`, { method: 'POST', body: form })
  } catch (error) {
    throw new SightengineError(
      error instanceof Error ? error.message : 'Appel Sightengine impossible.',
    )
  }
  if (!response.ok) {
    throw new SightengineError(`Sightengine a repondu ${response.status}.`)
  }

  const data = (await response.json()) as Record<string, unknown>
  return verdictFromImageResponse(data, config)
}

// =========================================================================
// Video : soumission asynchrone + parsing du callback.
//
// Flux : on POUSSE la video (< 50 Mo) sur /1.0/video/check.json avec un callback_url. Sightengine
// repond un media id "med_..." (a memoriser -> cle R2, cf. pending store), puis appelle le
// callback en differe avec les frames analysees. Le verdict video = la frame la plus risquee.
// (Videos > 50 Mo : Upload API a brancher ensuite ; en attendant elles restent non scannees =
// masquees au public, fail-closed.)
// =========================================================================

/** Taille max pour le POST direct ; au-dela il faut l'Upload API. */
export const VIDEO_DIRECT_MAX_BYTES = 50 * 1024 * 1024

export interface VideoSubmitResult {
  /** Identifiant Sightengine "med_..." a relier a la cle R2 (pending store). */
  mediaId: string
}

/**
 * Soumet une VIDEO (< 50 Mo) en async. Renvoie le media id Sightengine. Le verdict arrivera plus
 * tard via le callback (`parseVideoCallback`). Throw `SightengineError` en cas d'echec (le media
 * n'est alors pas marque, re-tente au prochain passage).
 */
export const submitVideoBinary = async (
  bytes: ArrayBuffer,
  fileName: string,
  contentType: string,
  callbackUrl: string,
  config: SightengineConfig,
): Promise<VideoSubmitResult> => {
  const form = new FormData()
  form.append('models', MODELS)
  form.append('callback_url', callbackUrl)
  form.append('api_user', config.apiUser)
  form.append('api_secret', config.apiSecret)
  form.append('media', new Blob([bytes], { type: contentType }), fileName)

  let response: Response
  try {
    response = await fetch(`${API_BASE}/video/check.json`, { method: 'POST', body: form })
  } catch (error) {
    throw new SightengineError(
      error instanceof Error ? error.message : 'Soumission video Sightengine impossible.',
    )
  }
  if (!response.ok) {
    throw new SightengineError(`Sightengine (video) a repondu ${response.status}.`)
  }

  const data = (await response.json()) as {
    status?: string
    media?: { id?: string }
    error?: { message?: string }
  }
  if (data.status !== 'success' || typeof data.media?.id !== 'string') {
    throw new SightengineError(data.error?.message ?? 'Soumission video Sightengine refusee.')
  }
  return { mediaId: data.media.id }
}

export interface VideoCallbackResult {
  mediaId: string
  /** true quand l'analyse est terminee (status finished/stopped) -> on peut clore le media. */
  finished: boolean
  /** true si Sightengine signale un echec d'analyse. */
  failed: boolean
  /** Pire frame recue dans ce callback ; `framesAnalyzed` = nb de frames du payload. */
  verdict: ModerationVerdict
}

/**
 * Parse un callback video Sightengine. Chaque frame a la meme forme qu'une reponse image, donc on
 * reutilise le meme verdict par frame et on retient la plus risquee. Renvoie null si le payload
 * n'est pas exploitable.
 */
export const parseVideoCallback = (
  payload: Record<string, unknown>,
  config: SightengineConfig,
): VideoCallbackResult | null => {
  const media = payload.media as { id?: unknown } | undefined
  const data = payload.data as { status?: unknown; frames?: unknown } | undefined
  if (!media || typeof media.id !== 'string' || !data) return null

  const status = typeof data.status === 'string' ? data.status : ''
  const frames = Array.isArray(data.frames) ? data.frames : []

  let worst: ModerationVerdict = {
    decision: 'ok',
    topCategory: 'nudity',
    score: 0,
    framesAnalyzed: frames.length,
  }
  for (const frame of frames) {
    const verdict = verdictFromImageResponse(frame as Record<string, unknown>, config)
    const becomesFlag = verdict.decision === 'flag' && worst.decision !== 'flag'
    if (becomesFlag || verdict.score > worst.score) {
      worst = { ...verdict, framesAnalyzed: frames.length }
    }
  }

  return {
    mediaId: media.id,
    finished: status === 'finished' || status === 'stopped',
    failed: status === 'failure',
    verdict: worst,
  }
}
