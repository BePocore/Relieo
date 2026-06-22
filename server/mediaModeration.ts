import {
  mediaBaseUrl,
  r2GetText,
  r2KeyFromPublicUrl,
  r2ListObjects,
  r2PutText,
} from './r2.js'

// Pendant Vercel de l'état de modération écrit par le videur (cf. worker/src/moderation.ts et
// docs/STORAGE-moderation.md). Sert au filtrage public (api/project), à la console admin (lecture +
// approve/reject) et au signal de scan (api/hikes, bouton admin). Le videur reste la seule source
// qui APPELLE Sightengine ; ici on ne fait que lire/écrire l'état R2 et déclencher un scan.

const scannedPath = 'relieo/media-scanned.json'
const moderationPath = 'relieo/media-moderation.json'
const usagePath = 'relieo/media-moderation-usage.json'
const historyPath = 'relieo/media-moderation-history.json'
const maxHistoryEntries = 1500

// Plafonds du palier gratuit Sightengine (affichés dans l'onglet Coûts).
export const MODERATION_DAILY_LIMIT = 500
export const MODERATION_MONTHLY_LIMIT = 2000

export type MediaModerationStatus = 'flagged' | 'rejected'

export type MediaModerationEntry = {
  id: string
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  status: MediaModerationStatus
  aiCategory: string
  aiScore: number
  scannedAt: string
  reviewedAt: string | null
  reviewedBy: string | null
}

export type ModerationUsage = {
  day: string
  dayOps: number
  month: string
  monthOps: number
  updatedAt: string
}

export type MediaModerationDecision = 'approved' | 'rejected'

export type MediaModerationHistoryEntry = {
  id: string
  decision: MediaModerationDecision
  mediaIds: string[]
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  aiCategory: string
  aiScore: number
  decidedAt: string
  decidedBy: string
  decidedByEmail: string | null
  message: string
  source: 'admin' | 'auto'
}

// Rapport d'un passage de scan, renvoyé par le videur (voir worker/src/scan.ts:ScanReport).
// Affiché par la console admin après un clic sur « Lancer un scan ».
export type ScanReport = {
  ok: boolean
  reason?: string
  processed: number
  flagged: number
  videosSubmitted: number
  seeded: number
  skipped: number
  capReached: boolean
  dayOps: number
  monthOps: number
}

// "1" = blocage fail-closed actif (identique au flag MODERATION_ENFORCE du videur). Tant que c'est
// "0", on NE filtre PAS à la lecture côté public (sinon on masquerait des médias que le videur sert
// encore). Les deux côtés se basculent ensemble.
export const moderationEnforced = (): boolean => process.env.MODERATION_ENFORCE === '1'

// Le signal vers le videur est-il configuré ? Sert à distinguer « pas de modération »
// (aucun secret) d'un simple timeout du scan (secret présent mais réponse > ~9 s).
export const moderationSignalConfigured = (): boolean =>
  Boolean(process.env.MODERATION_SIGNAL_SECRET)

// Score (0-1) au-dessus duquel un média signalé est SUPPRIMÉ automatiquement (sans
// revue admin). En dessous (mais au-dessus du seuil de flag du videur), il reste en
// revue manuelle. Réglable via MODERATION_AUTO_THRESHOLD ; défaut 0.7.
export const autoRejectThreshold = (): number => {
  const raw = Number(process.env.MODERATION_AUTO_THRESHOLD)
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.7
}

export const readScannedIds = async (): Promise<Set<string>> => {
  const ids = new Set<string>()
  const body = await r2GetText(scannedPath)
  if (!body) return ids
  try {
    const value = JSON.parse(body) as { ids?: unknown }
    if (Array.isArray(value.ids)) {
      for (const id of value.ids) if (typeof id === 'string') ids.add(id)
    }
  } catch {
    // Fichier illisible : aucun média connu comme validé (le public ne verra rien si enforce).
  }
  return ids
}

export const readModerationItems = async (): Promise<MediaModerationEntry[]> => {
  const body = await r2GetText(moderationPath)
  if (!body) return []
  try {
    const value = JSON.parse(body) as { items?: unknown }
    return Array.isArray(value.items) ? (value.items as MediaModerationEntry[]) : []
  } catch {
    return []
  }
}

/** Ensemble des clés bloquées (flaggées ou rejetées), pour le filtrage public rapide. */
export const readBlockedIds = async (): Promise<Set<string>> => {
  const items = await readModerationItems()
  return new Set(items.map((item) => item.id))
}

/** Un média (par sa clé R2) est servable au public s'il est scanné ET non bloqué. */
export const isPubliclyServable = (
  key: string,
  scanned: Set<string>,
  blocked: Set<string>,
): boolean => scanned.has(key) && !blocked.has(key)

const writeModerationItems = async (items: MediaModerationEntry[]): Promise<void> => {
  await r2PutText(
    moderationPath,
    JSON.stringify({ items, updatedAt: new Date().toISOString() }),
  )
}

/**
 * Approuver : l'IA s'est trompée. On retire l'entrée -> le média redevient servable (il reste dans
 * media-scanned.json). Renvoie l'entrée retirée (pour le journal des sanctions) ou null si absente.
 */
export const approveModerationItem = async (
  id: string,
): Promise<MediaModerationEntry | null> => {
  const items = await readModerationItems()
  const target = items.find((item) => item.id === id)
  if (!target) return null
  await writeModerationItems(items.filter((item) => item.id !== id))
  return target
}

/**
 * Rejeter : non conforme. Passe en `rejected` (bloqué même pour le propriétaire) toutes les entrées
 * dont l'id est dans `ids` (l'original ET sa vignette s'ils ont été flaggés tous les deux). La
 * suppression R2 + carte + notifs se fait dans l'action admin. Idempotent.
 */
export const rejectModerationItems = async (
  ids: string[],
  reviewedBy: string,
): Promise<void> => {
  const target = new Set(ids)
  const items = await readModerationItems()
  if (!items.some((item) => target.has(item.id))) return
  const reviewedAt = new Date().toISOString()
  await writeModerationItems(
    items.map((item) =>
      target.has(item.id)
        ? { ...item, status: 'rejected', reviewedAt, reviewedBy }
        : item,
    ),
  )
}

export const readModerationUsage = async (): Promise<ModerationUsage | null> => {
  const body = await r2GetText(usagePath)
  if (!body) return null
  try {
    const value = JSON.parse(body) as Partial<ModerationUsage>
    return {
      day: typeof value.day === 'string' ? value.day : '',
      dayOps: typeof value.dayOps === 'number' ? value.dayOps : 0,
      month: typeof value.month === 'string' ? value.month : '',
      monthOps: typeof value.monthOps === 'number' ? value.monthOps : 0,
      updatedAt:
        typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

export const readModerationHistory = async (): Promise<MediaModerationHistoryEntry[]> => {
  const body = await r2GetText(historyPath)
  if (!body) return []
  try {
    const value = JSON.parse(body) as { entries?: unknown }
    return Array.isArray(value.entries)
      ? (value.entries as MediaModerationHistoryEntry[])
      : []
  } catch {
    return []
  }
}

export const appendModerationHistory = async (
  entry: MediaModerationHistoryEntry,
): Promise<void> => {
  const entries = await readModerationHistory()
  const next = [entry, ...entries.filter((item) => item.id !== entry.id)].slice(
    0,
    maxHistoryEntries,
  )
  await r2PutText(
    historyPath,
    JSON.stringify({ entries: next, updatedAt: new Date().toISOString() }),
  )
}

// --- Inventaire complet des médias (console admin) ----------------------
// Liste TOUS les originaux (clés sous `.../media/`) avec leur état de modération :
// scanné ou non, exempté (carte non analysée par l'IA, ex. Halsa), verdict IA et
// décision admin. Construit côté Vercel à partir du listing R2 + des fichiers
// d'état ; `dashboard.ts` enrichit ensuite chaque entrée (email du propriétaire,
// code/titre de la carte, URL d'aperçu via le videur).

const MEDIA_USERS_PREFIX = 'relieo/users/'
const VIDEO_EXTENSION = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i

export type MediaInventoryAiStatus =
  | 'pending' // pas encore scanné
  | 'exempt' // carte exemptée (jamais envoyée à Sightengine)
  | 'ok' // scanné, validé par l'IA
  | 'flagged' // signalé par l'IA, en attente de revue admin
  | 'rejected' // supprimé par l'admin

export type MediaInventoryAdminStatus = 'none' | 'to-review' | 'rejected'

export type MediaInventoryEntry = {
  id: string
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  sizeBytes: number
  scanned: boolean
  exempt: boolean
  aiStatus: MediaInventoryAiStatus
  adminStatus: MediaInventoryAdminStatus
  aiCategory: string | null
  aiScore: number | null
  reviewedAt: string | null
  reviewedBy: string | null
}

// Cartes exemptées du scan (mêmes valeurs que le videur : var MODERATION_EXEMPT_FOLDERS,
// défaut « halsa »). Comparaison en minuscules.
const exemptFolders = (): Set<string> =>
  new Set(
    (process.env.MODERATION_EXEMPT_FOLDERS ?? 'halsa')
      .split(',')
      .map((folder) => folder.trim().toLowerCase())
      .filter(Boolean),
  )

const segmentAfter = (key: string, marker: string): string => {
  const parts = key.split('/')
  const index = parts.indexOf(marker)
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] : ''
}

/**
 * Inventaire de TOUS les médias (originaux) avec leur état de modération. `items` =
 * entrées flaggées/rejetées déjà lues par l'appelant (évite une relecture).
 */
export const buildMediaInventory = async (
  items: MediaModerationEntry[],
): Promise<MediaInventoryEntry[]> => {
  const [objects, scanned] = await Promise.all([
    r2ListObjects(MEDIA_USERS_PREFIX),
    readScannedIds(),
  ])
  const exempt = exemptFolders()
  const byId = new Map(items.map((item) => [item.id, item]))
  const sizeByKey = new Map(objects.map((object) => [object.key, object.size]))

  const toEntry = (key: string): MediaInventoryEntry => {
    const mapFolder = segmentAfter(key, 'randonnees')
    const isExempt = exempt.has(mapFolder.toLowerCase())
    const isScanned = scanned.has(key)
    const mod = byId.get(key)
    const aiStatus: MediaInventoryAiStatus =
      mod?.status === 'rejected'
        ? 'rejected'
        : mod?.status === 'flagged'
          ? 'flagged'
          : isExempt
            ? 'exempt'
            : isScanned
              ? 'ok'
              : 'pending'
    const adminStatus: MediaInventoryAdminStatus =
      mod?.status === 'rejected'
        ? 'rejected'
        : mod?.status === 'flagged'
          ? 'to-review'
          : 'none'
    return {
      id: key,
      ownerUid: segmentAfter(key, 'users'),
      mapFolder,
      mediaKind: VIDEO_EXTENSION.test(key) ? 'video' : 'image',
      sizeBytes: sizeByKey.get(key) ?? 0,
      scanned: isScanned,
      exempt: isExempt,
      aiStatus,
      adminStatus,
      aiCategory: mod?.aiCategory ?? null,
      aiScore: typeof mod?.aiScore === 'number' ? mod.aiScore : null,
      reviewedAt: mod?.reviewedAt ?? null,
      reviewedBy: mod?.reviewedBy ?? null,
    }
  }

  // Originaux présents dans R2 (on ignore les vignettes `previews/` et le reste).
  const originals = objects
    .map((object) => object.key)
    .filter((key) => key.includes('/media/'))
  const entries = originals.map(toEntry)

  // Médias rejetés : supprimés de R2 (absents du listing) mais conservés en trace.
  const present = new Set(originals)
  for (const item of items) {
    if (
      item.status === 'rejected' &&
      item.id.includes('/media/') &&
      !present.has(item.id)
    ) {
      entries.push(toEntry(item.id))
    }
  }
  return entries
}

/**
 * Signale au videur de lancer un scan, en priorisant `ids` (médias d'une publication). Best-effort
 * avec timeout court : on ne bloque jamais la réponse de l'appelant ; le cron 2×/jour rattrape sinon.
 */
export const signalModerationScan = async (ids: string[] = []): Promise<void> => {
  const secret = process.env.MODERATION_SIGNAL_SECRET
  if (!secret) return
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    await fetch(`${mediaBaseUrl()}/_moderation/scan?token=${encodeURIComponent(secret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
      signal: controller.signal,
    })
  } catch {
    // best-effort : panne réseau ou timeout, le scan de fond rattrapera.
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Lance un scan À LA DEMANDE (bouton admin) et ATTEND le rapport du videur. Contrairement à
 * `signalModerationScan` (fire-and-forget de la publication), on lit la réponse pour l'afficher.
 * Timeout ~9 s (limite d'une fonction Vercel Hobby) : si le scan dépasse, on renvoie null et le
 * videur continue en arrière-plan (le scan est incrémental, rien n'est perdu). Renvoie null aussi
 * tant que `MODERATION_SIGNAL_SECRET` n'est pas configuré (modération non activée).
 */
export const triggerModerationScan = async (): Promise<ScanReport | null> => {
  const secret = process.env.MODERATION_SIGNAL_SECRET
  if (!secret) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 9000)
  try {
    const response = await fetch(
      `${mediaBaseUrl()}/_moderation/scan?token=${encodeURIComponent(secret)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [] }),
        signal: controller.signal,
      },
    )
    if (!response.ok) return null
    return (await response.json()) as ScanReport
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

type FilterableProject = {
  mediaLibrary?: Array<{ url?: string; thumbnailUrl?: string; [key: string]: unknown }>
  points?: Array<{ image?: string; video?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/**
 * Couche 2 (confort d'affichage) : retire d'un projet, À LA LECTURE PUBLIQUE, les médias qui ne sont
 * pas servables (non scannés ou flaggés), pour ne pas laisser de marqueur vide chez le visiteur. La
 * vraie barrière reste le videur (refus d'octet). On ne touche jamais au fichier stocké, seulement à
 * la réponse. Le propriétaire et l'admin ne passent pas par ce filtre (ils voient tout, avec un
 * badge « en attente de vérification »). Une URL externe (hors R2) n'est jamais masquée.
 */
export const filterServableMedia = (
  project: FilterableProject,
  scanned: Set<string>,
  blocked: Set<string>,
): FilterableProject => {
  const servable = (url: string | undefined): boolean => {
    if (!url) return true
    const key = r2KeyFromPublicUrl(url)
    if (!key) return true
    return isPubliclyServable(key, scanned, blocked)
  }
  return {
    ...project,
    ...(Array.isArray(project.mediaLibrary)
      ? {
          mediaLibrary: project.mediaLibrary.filter(
            (media) => servable(media.url) && servable(media.thumbnailUrl),
          ),
        }
      : {}),
    ...(Array.isArray(project.points)
      ? {
          points: project.points.filter(
            (point) => servable(point.image) && servable(point.video),
          ),
        }
      : {}),
  }
}
