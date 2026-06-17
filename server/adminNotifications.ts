import { r2GetText, r2PutText } from './r2.js'

// Notifications destinées à l'admin (ex : message d'appel d'un utilisateur
// banni). Stockées dans R2 comme un simple JSON, à l'image de `sanctions.json`.
export const adminNotificationsPath = 'relieo/admin-notifications.json'

export type AdminNotification = {
  id: string
  type: 'appeal'
  fromUid: string
  fromEmail: string | null
  message: string
  createdAt: string
  read: boolean
}

const MAX_ENTRIES = 1000

export const readAdminNotifications = async (): Promise<AdminNotification[]> => {
  const body = await r2GetText(adminNotificationsPath)
  if (!body) return []
  try {
    const value = JSON.parse(body) as { notifications?: unknown }
    return Array.isArray(value.notifications)
      ? (value.notifications as AdminNotification[])
      : []
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
