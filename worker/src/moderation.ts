// État de modération IA des médias, lu/écrit par le videur via le binding R2.
//
// Contrat de données complet (4 fichiers) : voir docs/STORAGE-moderation.md. En résumé :
//   relieo/media-scanned.json           -> { ids }            clés déjà passées par l'IA
//   relieo/media-moderation.json        -> { items }          flaggés/rejetés (ce que l'admin voit)
//   relieo/media-moderation-usage.json  -> compteur d'ops Sightengine (jour/mois)
//   relieo/media-moderation-queue.json  -> { ids }            file prioritaire « publication »
//   relieo/media-moderation-alerts.json -> { ids }            groupes déjà signalés à l'admin
//
// Haut du fichier = chemin chaud (canServe, lu à chaque média servi, cache 60 s).
// Bas du fichier  = store (lecture/écriture, utilisé par le scan).
//
// Chaque clé R2 (média OU vignette) porte son propre statut : on scanne les deux et on bloque
// celui qui est sale, sans avoir à lier preview <-> original.
//
// Cache mémoire court (~60 s) au niveau du module : l'isolate du Worker le réutilise entre requêtes,
// pour ne pas relire R2 à chaque média servi. L'écriture par le scan invalide naturellement au bout
// du TTL (cohérence à la minute, suffisant pour de la modération).

const SCANNED_KEY = 'relieo/media-scanned.json'
const MODERATION_KEY = 'relieo/media-moderation.json'
const CACHE_TTL_MS = 60_000

export type ModerationStatus = 'flagged' | 'rejected'

export interface ModerationEntry {
  /** Clé R2 du média (ou de la vignette) concerné. */
  id: string
  status: ModerationStatus
}

interface ModerationState {
  /** Clés R2 scannées ET validées (servables au public). */
  scanned: Set<string>
  /** Clés R2 bloquées -> raison (flaggé en attente de revue, ou rejeté). */
  blocked: Map<string, ModerationStatus>
  loadedAt: number
}

let cache: ModerationState | null = null

const parseScanned = (text: string | null): Set<string> => {
  const ids = new Set<string>()
  if (!text) return ids
  try {
    const data = JSON.parse(text) as { ids?: unknown }
    if (Array.isArray(data.ids)) {
      for (const id of data.ids) if (typeof id === 'string') ids.add(id)
    }
  } catch {
    // Fichier illisible : on traite comme « rien de scanné » (fail-closed côté public).
  }
  return ids
}

const parseBlocked = (text: string | null): Map<string, ModerationStatus> => {
  const blocked = new Map<string, ModerationStatus>()
  if (!text) return blocked
  try {
    const data = JSON.parse(text) as { items?: unknown }
    if (Array.isArray(data.items)) {
      for (const raw of data.items) {
        const item = raw as Partial<ModerationEntry>
        if (
          typeof item.id === 'string' &&
          (item.status === 'flagged' || item.status === 'rejected')
        ) {
          blocked.set(item.id, item.status)
        }
      }
    }
  } catch {
    // Fichier illisible : aucun blocage connu (la couche « scanné » reste la garde).
  }
  return blocked
}

const loadState = async (bucket: R2Bucket): Promise<ModerationState> => {
  const now = Date.now()
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache

  const [scannedObj, moderationObj] = await Promise.all([
    bucket.get(SCANNED_KEY),
    bucket.get(MODERATION_KEY),
  ])
  const [scannedText, moderationText] = await Promise.all([
    scannedObj ? scannedObj.text() : Promise.resolve(null),
    moderationObj ? moderationObj.text() : Promise.resolve(null),
  ])

  cache = {
    scanned: parseScanned(scannedText),
    blocked: parseBlocked(moderationText),
    loadedAt: now,
  }
  return cache
}

/**
 * Décide si une clé R2 peut être servie, selon le rôle du ticket et l'état de modération.
 *
 * - `enforce === false` : modération pas encore activée -> comportement historique (tout passe).
 * - rôle `owner` (propriétaire / admin) : voit tout, SAUF ce qui est définitivement `rejected`
 *   (il garde la vue sur ses médias en attente et sur les flaggés à juger).
 * - rôle `public` (visiteur) : ne voit QUE ce qui est scanné ET non bloqué (fail-closed : un média
 *   non encore scanné, flaggé ou rejeté reste masqué).
 */
export const canServe = async (
  bucket: R2Bucket,
  key: string,
  role: 'public' | 'owner',
  enforce: boolean,
): Promise<boolean> => {
  if (!enforce) return true

  const state = await loadState(bucket)
  const blockedStatus = state.blocked.get(key)

  if (role === 'owner') return blockedStatus !== 'rejected'
  if (blockedStatus) return false
  return state.scanned.has(key)
}

/** Force le rechargement de l'état au prochain accès (après une écriture par le scan). */
export const invalidateModerationCache = (): void => {
  cache = null
}

// =========================================================================
// Store (côté scan) : lecture/écriture des 4 fichiers d'état. Voir
// docs/STORAGE-moderation.md pour le contrat de données.
// =========================================================================

const USAGE_KEY = 'relieo/media-moderation-usage.json'
const QUEUE_KEY = 'relieo/media-moderation-queue.json'
const ALERTS_KEY = 'relieo/media-moderation-alerts.json'
const ADMIN_NOTIFICATIONS_KEY = 'relieo/admin-notifications.json'
const MAX_ADMIN_NOTIFICATIONS = 1000

/** Entrée complète d'un média flaggé/rejeté (écrite par le scan, lue par l'admin Vercel). */
export interface MediaModerationEntry {
  id: string
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  status: ModerationStatus
  aiCategory: string
  aiScore: number
  scannedAt: string
  reviewedAt: string | null
  reviewedBy: string | null
}

export interface UsageSnapshot {
  day: string
  dayOps: number
  month: string
  monthOps: number
  updatedAt: string
}

const toNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const nowIso = (): string => new Date().toISOString()
const today = (): string => nowIso().slice(0, 10) // YYYY-MM-DD
const thisMonth = (): string => nowIso().slice(0, 7) // YYYY-MM

// --- Extraction d'infos depuis une clé R2 -------------------------------
const segmentAfter = (key: string, marker: string): string | null => {
  const parts = key.split('/')
  const index = parts.indexOf(marker)
  if (index === -1 || index + 1 >= parts.length) return null
  return parts[index + 1] || null
}

/** uid du propriétaire : segment après `users/`. */
export const ownerUidFromKey = (key: string): string | null => segmentAfter(key, 'users')

/** folder de la carte : segment après `randonnees/`. */
export const mapFolderFromKey = (key: string): string | null =>
  segmentAfter(key, 'randonnees')

// --- Lecture/écriture JSON générique (binding R2) -----------------------
const readJson = async <T>(bucket: R2Bucket, key: string, fallback: T): Promise<T> => {
  const object = await bucket.get(key)
  if (!object) return fallback
  try {
    return JSON.parse(await object.text()) as T
  } catch {
    return fallback
  }
}

const writeJson = async (bucket: R2Bucket, key: string, value: unknown): Promise<void> => {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store',
    },
  })
}

const mediaReviewAlertKey = (id: string): string => {
  const marker = id.includes('/media/')
    ? '/media/'
    : id.includes('/previews/')
      ? '/previews/'
      : ''
  if (!marker) return id

  const markerIndex = id.indexOf(marker)
  const prefix = id.slice(0, markerIndex)
  const fileName = id.slice(markerIndex + marker.length).split('/').pop() ?? ''
  const fingerprint =
    marker === '/media/'
      ? fileName.split('-')[0] || fileName
      : fileName.replace(/\.[^.]+$/, '')

  return `${prefix}/${fingerprint}`
}

const readAlertedMediaGroups = async (bucket: R2Bucket): Promise<Set<string>> => {
  const data = await readJson<{ ids?: unknown }>(bucket, ALERTS_KEY, {})
  const ids = new Set<string>()
  if (Array.isArray(data.ids)) {
    for (const id of data.ids) if (typeof id === 'string') ids.add(id)
  }
  return ids
}

export const appendMediaReviewNeededNotification = async (
  bucket: R2Bucket,
  entries: MediaModerationEntry[],
): Promise<number> => {
  if (entries.length === 0) return 0

  const alerted = await readAlertedMediaGroups(bucket)
  const byGroup = new Map<string, MediaModerationEntry>()
  for (const entry of entries) {
    const group = mediaReviewAlertKey(entry.id)
    if (!alerted.has(group) && !byGroup.has(group)) byGroup.set(group, entry)
  }

  const groups = [...byGroup.keys()]
  if (groups.length === 0) return 0

  const now = nowIso()
  const selected = [...byGroup.values()]
  const categories = [...new Set(selected.map((entry) => entry.aiCategory).filter(Boolean))]
    .slice(0, 3)
    .join(', ')
  const maps = [...new Set(selected.map((entry) => entry.mapFolder).filter(Boolean))]
  const countLabel = groups.length === 1 ? '1 média nécessite' : `${groups.length} médias nécessitent`
  const mapLabel =
    maps.length === 1
      ? ` Carte : ${maps[0]}.`
      : maps.length > 1
        ? ` Cartes : ${maps.slice(0, 3).join(', ')}${maps.length > 3 ? '…' : ''}.`
        : ''
  const categoryLabel = categories ? ` Catégorie(s) : ${categories}.` : ''

  const notification = {
    id: `media-review-${Date.now()}-${crypto.randomUUID()}`,
    type: 'media-review-needed',
    fromUid: 'moderation-ai',
    fromEmail: null,
    message: `${countLabel} une décision de modération IA.${categoryLabel}${mapLabel} Ouvre l'onglet Modération IA pour décider.`,
    createdAt: now,
    read: false,
    reply: null,
    mediaIds: selected.map((entry) => entry.id),
    mediaGroupIds: groups,
    mediaCount: groups.length,
  }

  const current = await readJson<{ notifications?: unknown }>(bucket, ADMIN_NOTIFICATIONS_KEY, {})
  const notifications = Array.isArray(current.notifications)
    ? current.notifications.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : []

  await writeJson(bucket, ADMIN_NOTIFICATIONS_KEY, {
    notifications: [notification, ...notifications].slice(0, MAX_ADMIN_NOTIFICATIONS),
  })

  for (const group of groups) alerted.add(group)
  await writeJson(bucket, ALERTS_KEY, { ids: [...alerted], updatedAt: now })

  return groups.length
}

// --- media-scanned.json -------------------------------------------------
/** Lecture fraîche (sans cache) de l'ensemble des clés déjà scannées. */
export const readScannedIds = async (bucket: R2Bucket): Promise<Set<string>> => {
  const data = await readJson<{ ids?: unknown }>(bucket, SCANNED_KEY, {})
  const ids = new Set<string>()
  if (Array.isArray(data.ids)) {
    for (const id of data.ids) if (typeof id === 'string') ids.add(id)
  }
  return ids
}

/** Marque des clés comme « déjà passées par l'IA » (quel que soit le verdict). Idempotent. */
export const addScannedIds = async (bucket: R2Bucket, ids: string[]): Promise<void> => {
  if (ids.length === 0) return
  const set = await readScannedIds(bucket)
  for (const id of ids) set.add(id)
  await writeJson(bucket, SCANNED_KEY, { ids: [...set], updatedAt: nowIso() })
  invalidateModerationCache()
}

// --- media-moderation.json ----------------------------------------------
export const readModerationItems = async (
  bucket: R2Bucket,
): Promise<MediaModerationEntry[]> => {
  const data = await readJson<{ items?: unknown }>(bucket, MODERATION_KEY, {})
  return Array.isArray(data.items) ? (data.items as MediaModerationEntry[]) : []
}

/** Ajoute ou remplace l'entrée d'un média flaggé/rejeté (clé = `entry.id`). */
export const upsertModerationItem = async (
  bucket: R2Bucket,
  entry: MediaModerationEntry,
): Promise<void> => {
  const items = await readModerationItems(bucket)
  const index = items.findIndex((item) => item.id === entry.id)
  if (index >= 0) items[index] = entry
  else items.push(entry)
  await writeJson(bucket, MODERATION_KEY, { items, updatedAt: nowIso() })
  invalidateModerationCache()
}

// --- media-moderation-usage.json ----------------------------------------
/** Lit le compteur d'ops en réinitialisant jour/mois si la période a changé. */
export const readUsage = async (bucket: R2Bucket): Promise<UsageSnapshot> => {
  const day = today()
  const month = thisMonth()
  const data = await readJson<Partial<UsageSnapshot>>(bucket, USAGE_KEY, {})
  return {
    day,
    dayOps: data.day === day ? toNumber(data.dayOps) : 0,
    month,
    monthOps: data.month === month ? toNumber(data.monthOps) : 0,
    updatedAt: nowIso(),
  }
}

/** Incrémente le compteur d'ops (1 par image, nb de frames par vidéo) et renvoie l'état à jour. */
export const bumpUsage = async (bucket: R2Bucket, ops: number): Promise<UsageSnapshot> => {
  const current = await readUsage(bucket)
  const next: UsageSnapshot = {
    day: current.day,
    dayOps: current.dayOps + ops,
    month: current.month,
    monthOps: current.monthOps + ops,
    updatedAt: nowIso(),
  }
  await writeJson(bucket, USAGE_KEY, next)
  return next
}

// --- media-moderation-queue.json (file prioritaire « publication ») -----
export const readQueue = async (bucket: R2Bucket): Promise<string[]> => {
  const data = await readJson<{ ids?: unknown }>(bucket, QUEUE_KEY, {})
  return Array.isArray(data.ids)
    ? data.ids.filter((id): id is string => typeof id === 'string')
    : []
}

/** Ajoute des médias en tête de file prioritaire (sans doublon). */
export const enqueueForScan = async (bucket: R2Bucket, ids: string[]): Promise<void> => {
  if (ids.length === 0) return
  const existing = await readQueue(bucket)
  const merged = [...new Set([...ids, ...existing])]
  await writeJson(bucket, QUEUE_KEY, { ids: merged, updatedAt: nowIso() })
}

/** Retire des médias de la file (après traitement). */
export const removeFromQueue = async (bucket: R2Bucket, ids: string[]): Promise<void> => {
  if (ids.length === 0) return
  const remaining = (await readQueue(bucket)).filter((id) => !ids.includes(id))
  await writeJson(bucket, QUEUE_KEY, { ids: remaining, updatedAt: nowIso() })
}

// --- media-moderation-pending.json (jobs vidéo async en attente de callback) ---
const PENDING_KEY = 'relieo/media-moderation-pending.json'

/** Une vidéo soumise à Sightengine, en attente de son callback. Lie le med_id à la clé R2. */
export interface PendingVideoJob {
  /** Identifiant Sightengine "med_...". */
  mediaId: string
  /** Clé R2 de la vidéo concernée. */
  mediaKey: string
  ownerUid: string
  mapFolder: string
  submittedAt: string
}

export const readPendingJobs = async (bucket: R2Bucket): Promise<PendingVideoJob[]> => {
  const data = await readJson<{ jobs?: unknown }>(bucket, PENDING_KEY, {})
  return Array.isArray(data.jobs) ? (data.jobs as PendingVideoJob[]) : []
}

/** Enregistre (ou remplace) un job vidéo en attente, indexé par son med_id. */
export const addPendingJob = async (bucket: R2Bucket, job: PendingVideoJob): Promise<void> => {
  const jobs = (await readPendingJobs(bucket)).filter((item) => item.mediaId !== job.mediaId)
  jobs.push(job)
  await writeJson(bucket, PENDING_KEY, { jobs, updatedAt: nowIso() })
}

export const findPendingJob = async (
  bucket: R2Bucket,
  mediaId: string,
): Promise<PendingVideoJob | null> => {
  return (await readPendingJobs(bucket)).find((item) => item.mediaId === mediaId) ?? null
}

/** Retire un job vidéo (après réception du callback final). */
export const removePendingJob = async (bucket: R2Bucket, mediaId: string): Promise<void> => {
  const jobs = (await readPendingJobs(bucket)).filter((item) => item.mediaId !== mediaId)
  await writeJson(bucket, PENDING_KEY, { jobs, updatedAt: nowIso() })
}
