import { r2GetText, r2PutText } from './r2.js'
import { appendAdminNotification } from './adminNotifications.js'

// Surveillance des comptes illimités (Cartographe / maison) : pas de blocage,
// mais une notification admin quand l'usage franchit un palier. Évite le spam
// via un état R2 qui mémorise le dernier palier notifié par compte.

const STATE_PATH = 'relieo/storage-alerts.json'
const GB = 1_000_000_000
// Palier d'alerte : une notif à chaque tranche de 50 Go franchie.
const STEP_GB = 50

type AlertState = Record<string, number> // uid -> dernier palier (Go) notifié

const readState = async (): Promise<AlertState> => {
  const body = await r2GetText(STATE_PATH)
  if (!body) return {}
  try {
    const value = JSON.parse(body) as AlertState
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

const writeState = async (state: AlertState): Promise<void> => {
  await r2PutText(STATE_PATH, JSON.stringify(state))
}

// À appeler pour un compte illimité avec son usage courant. Dépose une notif
// admin si un nouveau palier de STEP_GB est franchi. Best-effort (ne jette pas).
export const maybeAlertStorageThreshold = async (
  uid: string,
  email: string | null,
  usedBytes: number,
): Promise<void> => {
  try {
    const usedGb = usedBytes / GB
    const currentLevel = Math.floor(usedGb / STEP_GB) * STEP_GB
    if (currentLevel < STEP_GB) return // sous le premier palier (50 Go)

    const state = await readState()
    const lastLevel = state[uid] ?? 0
    if (currentLevel <= lastLevel) return // palier déjà notifié

    await appendAdminNotification({
      id: `storage-${uid}-${currentLevel}-${Date.now()}`,
      type: 'storage-threshold',
      fromUid: uid,
      fromEmail: email,
      message: `Le compte ${email ?? uid} (illimité) a dépassé ${currentLevel} Go de stockage R2 (usage ${usedGb.toFixed(1)} Go). Facturé à l'usage sur Cloudflare.`,
      createdAt: new Date().toISOString(),
      read: false,
      reply: null,
    })

    state[uid] = currentLevel
    await writeState(state)
  } catch {
    // Best-effort : une alerte manquée ne doit jamais casser la lecture d'usage.
  }
}
