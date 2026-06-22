// Client de l'API de moderation Sightengine, cote videur.
//
// Le bucket R2 etant prive, on NE transmet jamais d'URL : on POUSSE le binaire du media (methode
// recommandee par Sightengine pour du contenu non public). Les images partent en multipart sur
// /1.0/check.json (verdict synchrone). Les videos passeront par l'Upload API + callback async
// (ajoute dans un second temps).
//
// Verdict normalise : { decision, topCategory, score, framesAnalyzed }. Une image = 1 frame = 1 op.

const API_BASE = 'https://api.sightengine.com/1.0'

// Modeles demandes (images ET frames video). nudity-2.1 = derniere version NSFW ; gore = sang/blessures ;
// offensive = symboles/gestes haineux ; violence = scenes de bagarre/agression (un char ou une arme
// dans un paysage calme n'est PAS une scene violente -> reste OK). (weapon/wad volontairement non
// actives : generateurs de faux positifs sur un site voyage/sport, chasse/tir/couteau de cuisine.)
const MODELS = 'nudity-2.1,gore,offensive,violence'

export interface SightengineConfig {
  apiUser: string
  apiSecret: string
  /** Seuils de flag (0-1). Bas = flag large (on prefere un faux positif que l'admin leve vite). */
  nudityThreshold: number
  goreThreshold: number
  offensiveThreshold: number
  violenceThreshold: number
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

// Erreur PERMANENTE (ex: Upload API non dispo sur le palier gratuit) : inutile de
// re-tenter, le média part en revue manuelle.
export class SightengineUnsupportedError extends SightengineError {}

// Vrai si le corps de réponse indique une restriction de plan/usage (palier gratuit).
// On PARSE le JSON (type/code de l'objet error) au lieu d'un regex, pour ne pas matcher
// par accident un timestamp ou un id contenant « 1101 ».
const isPlanRestriction = (body: string): boolean => {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } }
    const type = parsed.error?.type
    const code = parsed.error?.code
    return (
      type === 'usage_limit' ||
      (typeof code === 'number' && code >= 1100 && code <= 1110)
    )
  } catch {
    return false
  }
}

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
    {
      category: 'violence',
      score: num((data.violence as Record<string, unknown> | undefined)?.prob),
      threshold: config.violenceThreshold,
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
// Deux flux selon la taille (limite Sightengine : 50 Mo pour le POST direct) :
//  - <= 50 Mo : on POUSSE la video sur /1.0/video/check.json (multipart) avec un callback_url.
//  - >  50 Mo : Upload API en 3 temps (cf. submitVideoViaUpload) : creer une URL d'upload, y PUT le
//    fichier en STREAMING depuis R2 (binaire brut, pas de buffer memoire), puis lancer la moderation
//    sur le media_id.
// Dans les deux cas Sightengine repond un media id "med_..." (a memoriser -> cle R2, cf. pending
// store) et appelle le callback en differe avec les frames analysees. Verdict = la frame la plus
// risquee.
// =========================================================================

/** Taille max pour le POST direct ; au-dela il faut l'Upload API (limite Sightengine). */
export const VIDEO_DIRECT_MAX_BYTES = 50 * 1024 * 1024

/** Plafond pour l'Upload API en un seul PUT : au-dela, un envoi resumable par morceaux serait
 *  necessaire (non implemente). Le scan bascule ces videos en revue manuelle. */
export const VIDEO_UPLOAD_MAX_BYTES = 512 * 1024 * 1024

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
    const body = await response.text().catch(() => '')
    if (isPlanRestriction(body)) {
      throw new SightengineUnsupportedError(
        `Moderation video Sightengine indisponible (palier gratuit) : ${body.slice(0, 200)}`,
      )
    }
    throw new SightengineError(
      `Sightengine (video) a repondu ${response.status}. ${body.slice(0, 400)}`,
    )
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

interface CreateVideoUpload {
  uploadUrl: string
  mediaId: string
}

// Etape 1 de l'Upload API : cree une URL d'upload (resumable) + un media id. GET avec les
// identifiants en query string (cf. https://sightengine.com/docs/upload-api).
const createVideoUpload = async (config: SightengineConfig): Promise<CreateVideoUpload> => {
  const url =
    `${API_BASE}/upload/create-video.json` +
    `?api_user=${encodeURIComponent(config.apiUser)}` +
    `&api_secret=${encodeURIComponent(config.apiSecret)}`
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new SightengineError(
      error instanceof Error ? error.message : 'Creation d’upload Sightengine impossible.',
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    if (isPlanRestriction(body)) {
      throw new SightengineUnsupportedError(
        `Upload API Sightengine indisponible (palier gratuit) : ${body.slice(0, 200)}`,
      )
    }
    throw new SightengineError(
      `Sightengine (create-upload) a repondu ${response.status}. ${body.slice(0, 400)}`,
    )
  }
  const data = (await response.json()) as {
    status?: string
    upload?: { url?: string }
    media?: { id?: string }
    error?: { message?: string }
  }
  if (data.status !== 'success' || !data.upload?.url || typeof data.media?.id !== 'string') {
    throw new SightengineError(data.error?.message ?? 'Creation d’upload Sightengine refusee.')
  }
  return { uploadUrl: data.upload.url, mediaId: data.media.id }
}

/**
 * Modere une VIDEO > 50 Mo via l'Upload API, en 3 temps :
 *  1. cree une URL d'upload Sightengine (+ media id),
 *  2. y POUSSE le fichier en STREAMING depuis R2 (PUT binaire brut). On fixe le Content-Length via
 *     `FixedLengthStream(size)` (le stockage attend une taille connue, pas du chunked) : aucun
 *     chargement complet en memoire du Worker, meme pour plusieurs centaines de Mo.
 *  3. lance la moderation async sur le media_id (callback differe, comme le flux < 50 Mo).
 * Throw `SightengineError` en cas d'echec (le media n'est alors pas marque, re-tente au passage suivant).
 */
export const submitVideoViaUpload = async (
  body: ReadableStream<Uint8Array>,
  size: number,
  contentType: string,
  callbackUrl: string,
  config: SightengineConfig,
): Promise<VideoSubmitResult> => {
  const { uploadUrl, mediaId } = await createVideoUpload(config)

  // PUT binaire brut en flux, Content-Length connu (FixedLengthStream).
  const fixed = new FixedLengthStream(size)
  void body.pipeTo(fixed.writable).catch(() => {
    // Une erreur de pipe fera echouer le fetch ci-dessous (flux en erreur) -> SightengineError.
  })
  let putResponse: Response
  try {
    putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: fixed.readable,
    })
  } catch (error) {
    throw new SightengineError(
      error instanceof Error ? error.message : 'Upload video Sightengine impossible.',
    )
  }
  if (!putResponse.ok) {
    throw new SightengineError(`Sightengine (PUT upload) a repondu ${putResponse.status}.`)
  }

  // Lance la moderation async sur le media deja uploade.
  const form = new FormData()
  form.append('models', MODELS)
  form.append('callback_url', callbackUrl)
  form.append('api_user', config.apiUser)
  form.append('api_secret', config.apiSecret)
  form.append('media_id', mediaId)

  let response: Response
  try {
    response = await fetch(`${API_BASE}/video/check.json`, { method: 'POST', body: form })
  } catch (error) {
    throw new SightengineError(
      error instanceof Error ? error.message : 'Soumission video Sightengine impossible.',
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    if (isPlanRestriction(body)) {
      throw new SightengineUnsupportedError(
        `Moderation video Sightengine indisponible (palier gratuit) : ${body.slice(0, 200)}`,
      )
    }
    throw new SightengineError(
      `Sightengine (video) a repondu ${response.status}. ${body.slice(0, 400)}`,
    )
  }
  const data = (await response.json()) as {
    status?: string
    media?: { id?: string }
    error?: { message?: string }
  }
  if (data.status !== 'success') {
    throw new SightengineError(data.error?.message ?? 'Soumission video Sightengine refusee.')
  }
  // Le callback reference l'id du media (celui de create-video, conserve par check.json).
  return { mediaId: typeof data.media?.id === 'string' ? data.media.id : mediaId }
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
