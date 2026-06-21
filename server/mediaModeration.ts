import { mediaBaseUrl, r2GetText, r2PutText } from './r2.js'

// Pendant Vercel de l'état de modération écrit par le videur (cf. worker/src/moderation.ts et
// docs/STORAGE-moderation.md). Sert au filtrage public (api/project), à la console admin (lecture +
// approve/reject) et au signal de scan (api/hikes, bouton admin). Le videur reste la seule source
// qui APPELLE Sightengine ; ici on ne fait que lire/écrire l'état R2 et déclencher un scan.

const scannedPath = 'relieo/media-scanned.json'
const moderationPath = 'relieo/media-moderation.json'
const usagePath = 'relieo/media-moderation-usage.json'

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

// "1" = blocage fail-closed actif (identique au flag MODERATION_ENFORCE du videur). Tant que c'est
// "0", on NE filtre PAS à la lecture côté public (sinon on masquerait des médias que le videur sert
// encore). Les deux côtés se basculent ensemble.
export const moderationEnforced = (): boolean => process.env.MODERATION_ENFORCE === '1'

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
 * Rejeter : non conforme. Passe l'entrée en `rejected` (bloquée même pour le propriétaire). La
 * suppression R2 + carte + notifs se fait dans l'action admin. Renvoie l'entrée mise à jour.
 */
export const rejectModerationItem = async (
  id: string,
  reviewedBy: string,
): Promise<MediaModerationEntry | null> => {
  const items = await readModerationItems()
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return null
  items[index] = {
    ...items[index],
    status: 'rejected',
    reviewedAt: new Date().toISOString(),
    reviewedBy,
  }
  await writeModerationItems(items)
  return items[index]
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
