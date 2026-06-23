import { r2GetText, r2PutText } from './r2.js'

// Notifications destinées à l'admin (ex : message d'appel d'un utilisateur
// banni). Stockées dans R2 comme un simple JSON, à l'image de `sanctions.json`.
export const adminNotificationsPath = 'relieo/admin-notifications.json'

export type AdminNotification = {
  id: string
  type: 'appeal' | 'deletion-request' | 'media-review-needed' | 'media-scan-summary'
  fromUid: string
  fromEmail: string | null
  message: string
  createdAt: string
  read: boolean
  mediaIds?: string[]
  mediaGroupIds?: string[]
  mediaCount?: number
  scanSummary?: {
    ok: boolean
    reason?: string
    validated: number
    autoRejected: number
    pendingReview: number
    processed: number
    videosSubmitted: number
    capReached: boolean
  }
  // Réponse de l'admin À CET appel précis (par notification, pas par utilisateur).
  reply: { message: string; sentAt: string } | null
}

const MAX_ENTRIES = 1000

export const readAdminNotifications = async (): Promise<AdminNotification[]> => {
  const body = await r2GetText(adminNotificationsPath)
  if (!body) return []
  try {
    const value = JSON.parse(body) as { notifications?: unknown }
    if (!Array.isArray(value.notifications)) return []
    return (value.notifications as AdminNotification[]).map((item) => ({
      ...item,
      reply: item.reply ?? null,
    }))
  } catch {
    return []
  }
}

export const appendAdminNotification = async (
  entry: AdminNotification,
): Promise<void> => {
  const current = await readAdminNotifications()
  const next = [entry, ...current].slice(0, MAX_ENTRIES)
  await r2PutText(adminNotificationsPath, JSON.stringify({ notifications: next }))
}

// Passe les notifications listées (par id) à l'état lu.
export const markAdminNotificationsRead = async (
  ids: string[],
): Promise<void> => {
  const current = await readAdminNotifications()
  const idSet = new Set(ids)
  const next = current.map((item) =>
    idSet.has(item.id) ? { ...item, read: true } : item,
  )
  await r2PutText(adminNotificationsPath, JSON.stringify({ notifications: next }))
}

// Enregistre la réponse de l'admin sur une notification précise (et la marque
// lue). Renvoie l'uid de l'auteur de l'appel, ou null si introuvable.
export const setAdminNotificationReply = async (
  id: string,
  message: string,
): Promise<string | null> => {
  const current = await readAdminNotifications()
  const target = current.find((item) => item.id === id)
  if (!target) return null
  const next = current.map((item) =>
    item.id === id
      ? { ...item, read: true, reply: { message, sentAt: new Date().toISOString() } }
      : item,
  )
  await r2PutText(adminNotificationsPath, JSON.stringify({ notifications: next }))
  return target.fromUid
}
