import { r2GetText, r2PutText } from './r2.js'
import { appendAdminNotification } from './adminNotifications.js'

// Surveillance du stockage des comptes : PAS de blocage, seulement des
// notifications admin. Deux mécanismes, dédupliqués via un état R2 par compte :
//  - comptes illimités (Cartographe / maison) : une notif à chaque palier de
//    50 Go franchi ;
//  - n'importe quel compte : une notif quand l'usage dépasse le seuil réglé
//    par l'admin pour ce compte (`storageAlertGb`).

const STATE_PATH = 'relieo/storage-alerts.json'
const GB = 1_000_000_000
const STEP_GB = 50

// État par compte. Rétrocompat : l'ancien format stockait directement le palier
// (un nombre) au lieu d'un objet.
type Entry = { step?: number; userThreshold?: number }
type AlertState = Record<string, Entry>

const readState = async (): Promise<AlertState> => {
  const body = await r2GetText(STATE_PATH)
  if (!body) return {}
  try {
    const raw = JSON.parse(body) as Record<string, unknown>
    const state: AlertState = {}
    for (const [uid, value] of Object.entries(raw)) {
      if (typeof value === 'number') state[uid] = { step: value }
      else if (value && typeof value === 'object') state[uid] = value as Entry
    }
    return state
  } catch {
    return {}
  }
}

const writeState = async (state: AlertState): Promise<void> => {
  await r2PutText(STATE_PATH, JSON.stringify(state))
}

// Compte illimité : notif à chaque tranche de STEP_GB franchie.
export const maybeAlertStorageThreshold = async (
  uid: string,
  email: string | null,
  usedBytes: number,
): Promise<void> => {
  try {
    const usedGb = usedBytes / GB
    const currentLevel = Math.floor(usedGb / STEP_GB) * STEP_GB
    if (currentLevel < STEP_GB) return

    const state = await readState()
    const entry = state[uid] ?? {}
    if (currentLevel <= (entry.step ?? 0)) return

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

    state[uid] = { ...entry, step: currentLevel }
    await writeState(state)
  } catch {
    // Best-effort : ne jamais casser la lecture d'usage.
  }
}

// N'importe quel compte : notif quand l'usage dépasse le seuil réglé par
// l'admin (`thresholdGb`). Une seule notif tant qu'on reste au-dessus ; réarmé
// si l'usage repasse sous le seuil ou si l'admin change le seuil.
export const maybeAlertUserStorageThreshold = async (
  uid: string,
  email: string | null,
  usedBytes: number,
  thresholdGb: number,
): Promise<void> => {
  try {
    if (!(thresholdGb > 0)) return
    const usedGb = usedBytes / GB
    const state = await readState()
    const entry = state[uid] ?? {}

    if (usedGb < thresholdGb) {
      // Sous le seuil : réarmer si on avait déjà alerté.
      if (entry.userThreshold !== undefined) {
        state[uid] = { ...entry, userThreshold: undefined }
        await writeState(state)
      }
      return
    }

    // Au-dessus : notifier une fois pour ce seuil précis.
    if (entry.userThreshold === thresholdGb) return

    await appendAdminNotification({
      id: `ustorage-${uid}-${thresholdGb}-${Date.now()}`,
      type: 'storage-threshold',
      fromUid: uid,
      fromEmail: email,
      message: `Le compte ${email ?? uid} a dépassé son seuil d'alerte de ${thresholdGb} Go (usage ${usedGb.toFixed(1)} Go).`,
      createdAt: new Date().toISOString(),
      read: false,
      reply: null,
    })

    state[uid] = { ...entry, userThreshold: thresholdGb }
    await writeState(state)
  } catch {
    // Best-effort.
  }
}
