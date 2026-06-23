// Boucle de scan + traitement des callbacks vidéo, exécutée dans le videur (cron toutes les 4 h et signal
// de publication). Voir docs/PLAN-moderation-ia.md (Brique 1.3) et docs/STORAGE-moderation.md.
//
// On POUSSE les octets à Sightengine (binding R2, bucket privé) : images en synchrone, vidéos en
// async (callback). Ordre : file prioritaire « publication » d'abord, puis balayage de fond. On
// s'arrête au cap quotidien et à MAX_MEDIA_PER_RUN (limites Cloudflare Free) ; le reste repasse au
// tick suivant. Les cartes exemptées (Halsa) sont marquées « scannées » sans appel (seed implicite).

import {
  moderateImageBinary,
  submitVideoBinary,
  submitVideoViaUpload,
  parseVideoCallback,
  SightengineError,
  SightengineUnsupportedError,
  VIDEO_DIRECT_MAX_BYTES,
  VIDEO_UPLOAD_MAX_BYTES,
  type SightengineConfig,
  type ModerationVerdict,
} from './sightengine'
import {
  readScannedIds,
  addScannedIds,
  upsertModerationItem,
  appendMediaReviewNeededNotification,
  readUsage,
  bumpUsage,
  readQueue,
  removeFromQueue,
  addPendingJob,
  findPendingJob,
  removePendingJob,
  ownerUidFromKey,
  mapFolderFromKey,
  type MediaModerationEntry,
} from './moderation'

export interface ModerationEnv {
  MEDIA_BUCKET: R2Bucket
  SIGHTENGINE_API_USER?: string
  SIGHTENGINE_API_SECRET?: string
  MODERATION_ENFORCE?: string
  MODERATION_EXEMPT_FOLDERS?: string
  MODERATION_DAILY_OP_CAP?: string
  MODERATION_CALLBACK_BASE?: string
  MODERATION_CALLBACK_SECRET?: string
  MODERATION_SIGNAL_SECRET?: string
  MODERATION_NUDITY_THRESHOLD?: string
  MODERATION_GORE_THRESHOLD?: string
  MODERATION_OFFENSIVE_THRESHOLD?: string
  MODERATION_VIOLENCE_THRESHOLD?: string
  MODERATION_AUTO_THRESHOLD?: string
}

const MEDIA_PREFIX = 'relieo/users/'
const MAX_MEDIA_PER_RUN = 40 // sous la limite ~50 sous-requêtes externes Cloudflare Free
const DEFAULT_DAILY_CAP = 480 // sous les 500 ops/jour du palier gratuit
const CALLBACK_BASE_DEFAULT = 'https://media.relieo.fr'

export interface ScanReport {
  ok: boolean
  reason?: string
  processed: number // médias traités dans ce passage (images + vidéos soumises)
  flagged: number
  videosSubmitted: number
  seeded: number // exemptées marquées sans appel
  skipped: number // réservé aux cas temporairement différés
  capReached: boolean
  dayOps: number
  monthOps: number
}

const threshold = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}

const buildConfig = (env: ModerationEnv): SightengineConfig | null => {
  if (!env.SIGHTENGINE_API_USER || !env.SIGHTENGINE_API_SECRET) return null
  return {
    apiUser: env.SIGHTENGINE_API_USER,
    apiSecret: env.SIGHTENGINE_API_SECRET,
    nudityThreshold: threshold(env.MODERATION_NUDITY_THRESHOLD, 0.5),
    goreThreshold: threshold(env.MODERATION_GORE_THRESHOLD, 0.5),
    offensiveThreshold: threshold(env.MODERATION_OFFENSIVE_THRESHOLD, 0.5),
    violenceThreshold: threshold(env.MODERATION_VIOLENCE_THRESHOLD, 0.5),
  }
}

const exemptSet = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? '')
      .split(',')
      .map((folder) => folder.trim().toLowerCase())
      .filter(Boolean),
  )

const isExempt = (key: string, exempt: Set<string>): boolean => {
  const folder = mapFolderFromKey(key)
  return folder ? exempt.has(folder.toLowerCase()) : false
}

const isModerableKey = (key: string): boolean =>
  (key.includes('/media/') || key.includes('/previews/')) && !key.endsWith('.json')

const buildFlaggedEntry = (
  key: string,
  mediaKind: 'image' | 'video',
  verdict: ModerationVerdict,
): MediaModerationEntry => ({
  id: key,
  ownerUid: ownerUidFromKey(key) ?? '',
  mapFolder: mapFolderFromKey(key) ?? '',
  mediaKind,
  status: 'flagged',
  aiCategory: verdict.topCategory,
  aiScore: verdict.score,
  scannedAt: new Date().toISOString(),
  reviewedAt: null,
  reviewedBy: null,
})

const shouldNotifyAdmin = (
  entry: MediaModerationEntry,
  autoThreshold: number,
): boolean => entry.status === 'flagged' && entry.aiScore < autoThreshold

const notifyAdminBestEffort = async (
  bucket: R2Bucket,
  entries: MediaModerationEntry[],
): Promise<void> => {
  if (entries.length === 0) return
  try {
    const count = await appendMediaReviewNeededNotification(bucket, entries)
    if (count > 0) console.info('[moderation] notification admin media-review-needed', count)
  } catch (error) {
    console.warn(
      '[moderation] echec notification admin',
      error instanceof Error ? error.message : String(error),
    )
  }
}

// Collecte jusqu'à `limit` clés à scanner : la file prioritaire d'abord, puis le balayage de fond.
// Sépare les clés exemptées (à seeder) des clés à envoyer à Sightengine.
const collectCandidates = async (
  bucket: R2Bucket,
  queue: string[],
  scanned: Set<string>,
  exempt: Set<string>,
  limit: number,
): Promise<{ toScan: string[]; toSeed: string[] }> => {
  const toScan: string[] = []
  const toSeed: string[] = []
  const seen = new Set<string>()

  // Renvoie true quand on a atteint la limite de clés à scanner.
  const consider = (key: string): boolean => {
    if (seen.has(key) || scanned.has(key) || !isModerableKey(key)) return false
    seen.add(key)
    if (isExempt(key, exempt)) {
      toSeed.push(key)
      return false
    }
    toScan.push(key)
    return toScan.length >= limit
  }

  for (const key of queue) {
    if (consider(key)) return { toScan, toSeed }
  }

  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: MEDIA_PREFIX, cursor, limit: 1000 })
    for (const object of page.objects) {
      if (consider(object.key)) return { toScan, toSeed }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  return { toScan, toSeed }
}

/** Lance un passage de scan. Idempotent : ne retraite jamais une clé déjà scannée. */
export const runScan = async (env: ModerationEnv): Promise<ScanReport> => {
  const report: ScanReport = {
    ok: true,
    processed: 0,
    flagged: 0,
    videosSubmitted: 0,
    seeded: 0,
    skipped: 0,
    capReached: false,
    dayOps: 0,
    monthOps: 0,
  }

  const config = buildConfig(env)
  if (!config) return { ...report, ok: false, reason: 'Sightengine non configuré.' }

  const bucket = env.MEDIA_BUCKET
  const exempt = exemptSet(env.MODERATION_EXEMPT_FOLDERS)
  const autoThreshold = threshold(env.MODERATION_AUTO_THRESHOLD, 0.7)
  const cap =
    Number(env.MODERATION_DAILY_OP_CAP) > 0
      ? Number(env.MODERATION_DAILY_OP_CAP)
      : DEFAULT_DAILY_CAP
  const callbackUrl = `${(env.MODERATION_CALLBACK_BASE ?? CALLBACK_BASE_DEFAULT).replace(
    /\/$/,
    '',
  )}/_moderation/callback?token=${env.MODERATION_CALLBACK_SECRET ?? ''}`

  const scanned = await readScannedIds(bucket)
  const queue = await readQueue(bucket)
  const { toScan, toSeed } = await collectCandidates(
    bucket,
    queue,
    scanned,
    exempt,
    MAX_MEDIA_PER_RUN,
  )

  // Seed des cartes exemptées (Halsa) : marquées scannées, sans appel Sightengine.
  if (toSeed.length) {
    await addScannedIds(bucket, toSeed)
    report.seeded = toSeed.length
  }

  let usage = await readUsage(bucket)
  const done: string[] = [] // clés à retirer de la file prioritaire
  const reviewAlerts: MediaModerationEntry[] = []

  for (const key of toScan) {
    if (usage.dayOps >= cap) {
      report.capReached = true
      break
    }

    const object = await bucket.get(key)
    if (!object) {
      done.push(key) // objet disparu : on le sort de la file
      continue
    }
    const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream'
    const fileName = key.split('/').pop() ?? 'media'

    try {
      if (contentType.startsWith('video/')) {
        if (object.size > VIDEO_UPLOAD_MAX_BYTES) {
          // Trop gros même pour l'Upload API en un PUT (envoi resumable par morceaux non
          // implémenté). On le bascule en revue manuelle pour éviter un état non scanné
          // permanent : l'admin garde une décision explicite à prendre.
          const entry = buildFlaggedEntry(key, 'video', {
            decision: 'flag',
            topCategory: 'verification-manuelle',
            score: 0,
            framesAnalyzed: 0,
          })
          await upsertModerationItem(bucket, entry)
          if (shouldNotifyAdmin(entry, autoThreshold)) reviewAlerts.push(entry)
          await addScannedIds(bucket, [key])
          report.flagged += 1
          report.processed += 1
          done.push(key)
          continue
        }
        // <= 50 Mo : POST direct ; > 50 Mo : Upload API (PUT streamé depuis R2, pas de buffer).
        const { mediaId } =
          object.size > VIDEO_DIRECT_MAX_BYTES
            ? await submitVideoViaUpload(object.body, object.size, contentType, callbackUrl, config)
            : await submitVideoBinary(
                await object.arrayBuffer(),
                fileName,
                contentType,
                callbackUrl,
                config,
              )
        await addPendingJob(bucket, {
          mediaId,
          mediaKey: key,
          ownerUid: ownerUidFromKey(key) ?? '',
          mapFolder: mapFolderFromKey(key) ?? '',
          submittedAt: new Date().toISOString(),
        })
        report.videosSubmitted += 1
        // Verdict + comptage d'ops : à la réception du callback.
      } else {
        const bytes = await object.arrayBuffer()
        const verdict = await moderateImageBinary(bytes, fileName, contentType, config)
        if (verdict.decision === 'flag') {
          const entry = buildFlaggedEntry(key, 'image', verdict)
          await upsertModerationItem(bucket, entry)
          if (shouldNotifyAdmin(entry, autoThreshold)) reviewAlerts.push(entry)
          report.flagged += 1
        }
        await addScannedIds(bucket, [key])
        usage = await bumpUsage(bucket, verdict.framesAnalyzed) // 1 op pour une image
      }
      report.processed += 1
      done.push(key)
    } catch (error) {
      // Erreur PERMANENTE (ex: vidéo > 50 Mo, Upload API non dispo sur le palier gratuit) :
      // inutile de re-tenter. On envoie en REVUE MANUELLE (flaggé) + marqué scanné pour
      // sortir de la boucle ; reste masqué au public jusqu'à décision admin.
      if (error instanceof SightengineUnsupportedError) {
        console.warn('[moderation] revue manuelle (non analysable)', key, error.message)
        const entry = buildFlaggedEntry(key, 'video', {
          decision: 'flag',
          topCategory: 'verification-manuelle',
          score: 0,
          framesAnalyzed: 0,
        })
        await upsertModerationItem(bucket, entry)
        if (shouldNotifyAdmin(entry, autoThreshold)) reviewAlerts.push(entry)
        await addScannedIds(bucket, [key])
        report.flagged += 1
        report.processed += 1
        done.push(key)
        continue
      }
      // Panne transitoire : on ne marque pas scanné (re-tenté au prochain passage).
      // Log de diagnostic (visible via `wrangler tail`) : clé, type, taille, raison.
      console.warn(
        '[moderation] echec scan media',
        key,
        contentType,
        object.size,
        error instanceof Error ? error.message : String(error),
      )
      if (!(error instanceof SightengineError)) throw error
    }
  }

  if (done.length) await removeFromQueue(bucket, done)
  await notifyAdminBestEffort(bucket, reviewAlerts)
  report.dayOps = usage.dayOps
  report.monthOps = usage.monthOps
  return report
}

/** Traite un callback vidéo de Sightengine : écrit le verdict, clôt le job quand il est fini. */
export const handleVideoCallback = async (
  env: ModerationEnv,
  payload: Record<string, unknown>,
): Promise<void> => {
  const config = buildConfig(env)
  if (!config) return
  const autoThreshold = threshold(env.MODERATION_AUTO_THRESHOLD, 0.7)
  const result = parseVideoCallback(payload, config)
  if (!result) return

  const job = await findPendingJob(env.MEDIA_BUCKET, result.mediaId)
  if (!job) return // inconnu ou déjà clôturé (idempotent)

  if (result.verdict.decision === 'flag') {
    const entry = buildFlaggedEntry(job.mediaKey, 'video', result.verdict)
    await upsertModerationItem(env.MEDIA_BUCKET, entry)
    if (shouldNotifyAdmin(entry, autoThreshold)) {
      await notifyAdminBestEffort(env.MEDIA_BUCKET, [entry])
    }
  }

  if (result.finished || result.failed) {
    if (!result.failed) {
      await addScannedIds(env.MEDIA_BUCKET, [job.mediaKey])
      await bumpUsage(env.MEDIA_BUCKET, result.verdict.framesAnalyzed)
    }
    await removePendingJob(env.MEDIA_BUCKET, result.mediaId)
  }
}
