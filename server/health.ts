import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { adminApp } from './firebaseAdmin.js'

// ── Santé du client (monitoring maison) ─────────────────────────────────────
// 2026-07-20 : suite à des crashs/blocages réels chez des visiteurs qu'on n'a
// appris QUE par message (rien dans les logs Vercel, le backend est sain),
// on capte ici trois signaux minimaux, STRICTEMENT ANONYMES (même principe
// que `recordHikeView`/le tuto : aucun identifiant visiteur, écrit uniquement
// par l'Admin SDK depuis l'API, jamais par le client) :
//   - `js-error` / `unhandled-rejection` / `render-error` : erreurs JS captées
//     globalement (window.onerror, unhandledrejection, ErrorBoundary React)
//   - `veil-stuck` : le chien de garde du voile (25 s) se déclenche — avec
//     l'état EXACT de ce qui bloquait (tuiles ? vignettes ? combien sur
//     combien ?), pour ne plus deviner après coup
//   - des échantillons de TEMPS DE CHARGEMENT réel (mini-RUM), pour savoir ce
//     que vivent les vrais visiteurs au lieu d'extrapoler depuis un audit
//     Playwright sur un PC
//
// Volontairement minimal (pas Sentry) : un doc Firestore agrégé, compteurs
// atomiques + un buffer borné des derniers événements bruts (pour pouvoir les
// LIRE, pas seulement les compter). Assez pour diagnostiquer un incident réel
// vu le trafic actuel ; à remplacer par un vrai outil si le trafic grossit.

const HEALTH_COLLECTION = 'health_stats'
const HEALTH_DOC = 'client'

const HEALTH_EVENTS = [
  'js-error',
  'unhandled-rejection',
  'render-error',
  'veil-stuck',
] as const
export type HealthEventType = (typeof HEALTH_EVENTS)[number]

export const isHealthEventType = (value: unknown): value is HealthEventType =>
  typeof value === 'string' && (HEALTH_EVENTS as readonly string[]).includes(value)

export type HealthRoute = 'consult' | 'studio' | 'portal'
const isHealthRoute = (value: unknown): value is HealthRoute =>
  value === 'consult' || value === 'studio' || value === 'portal'

// Champs texte libres (message, stack) : bornés en longueur avant stockage —
// ils viennent d'un client anonyme, jamais fait confiance tels quels.
const clip = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

type RawHealthEvent = {
  type: HealthEventType
  at: string
  route?: HealthRoute
  message?: string
  stack?: string
  detail?: Record<string, unknown>
}

const MAX_EVENTS = 60
const MAX_TIMING_SAMPLES = 150

// Détail du voile bloqué : quelques compteurs simples, filtrés un par un
// (jamais un objet client stocké tel quel).
const safeDetail = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of [
    'tilesReady',
    'postersReady',
    'framedReady',
    'postersDone',
    'postersTotal',
    'framedDone',
    'framedTotal',
    'connection',
    'screen',
  ]) {
    const v = src[key]
    if (typeof v === 'boolean' || typeof v === 'number') out[key] = v
    else if (typeof v === 'string') out[key] = clip(v, 40)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

// Enregistre UN événement de santé. Best-effort : toute erreur est avalée
// (le monitoring ne doit jamais interrompre ni ralentir le visiteur).
export const recordHealthEvent = async (
  type: HealthEventType,
  fields: { route?: unknown; message?: unknown; stack?: unknown; detail?: unknown },
): Promise<void> => {
  try {
    const db = getFirestore(adminApp())
    const event: RawHealthEvent = { type, at: new Date().toISOString() }
    if (isHealthRoute(fields.route)) event.route = fields.route
    const message = clip(fields.message, 300)
    if (message) event.message = message
    const stack = clip(fields.stack, 500)
    if (stack) event.stack = stack
    const detail = safeDetail(fields.detail)
    if (detail) event.detail = detail

    await db
      .collection(HEALTH_COLLECTION)
      .doc(HEALTH_DOC)
      .set({ [`counts.${type}`]: FieldValue.increment(1) }, { merge: true })

    // Buffer borné des derniers événements bruts : read-modify-write non
    // atomique (best-effort, comme le reste) — un chevauchement rarissime au
    // trafic actuel ferait au pire perdre UN événement, sans consequence.
    const ref = db.collection(HEALTH_COLLECTION).doc(HEALTH_DOC)
    const snapshot = await ref.get()
    const existing = (snapshot.data()?.events as RawHealthEvent[] | undefined) ?? []
    const next = [...existing, event].slice(-MAX_EVENTS)
    await ref.set({ events: next }, { merge: true })
  } catch {
    // Monitoring best-effort : ne jamais faire échouer l'appelant pour ça.
  }
}

type TimingSample = {
  ms: number
  at: string
  route: HealthRoute
  connection?: string
  outcome: 'ready' | 'failed'
}

// Enregistre UN temps de chargement réel (voile → carte prête, ou échec).
export const recordHealthTiming = async (fields: {
  ms: unknown
  route: unknown
  connection?: unknown
  outcome?: unknown
}): Promise<void> => {
  try {
    const ms = Number(fields.ms)
    if (!Number.isFinite(ms) || ms < 0 || ms > 300_000) return
    if (!isHealthRoute(fields.route)) return
    const sample: TimingSample = {
      ms: Math.round(ms),
      at: new Date().toISOString(),
      route: fields.route,
      outcome: fields.outcome === 'failed' ? 'failed' : 'ready',
    }
    const connection = clip(fields.connection, 20)
    if (connection) sample.connection = connection

    const db = getFirestore(adminApp())
    const ref = db.collection(HEALTH_COLLECTION).doc(HEALTH_DOC)
    const snapshot = await ref.get()
    const existing = (snapshot.data()?.timing as TimingSample[] | undefined) ?? []
    const next = [...existing, sample].slice(-MAX_TIMING_SAMPLES)
    await ref.set({ timing: next }, { merge: true })
  } catch {
    // Best-effort.
  }
}

export type HealthStats = {
  counts: Record<string, number>
  events: RawHealthEvent[]
  timing: TimingSample[]
}

const EMPTY_HEALTH_STATS: HealthStats = { counts: {}, events: [], timing: [] }

// Lecture pour la console admin. Jamais d'erreur remontée.
export const readHealthStats = async (): Promise<HealthStats> => {
  try {
    const db = getFirestore(adminApp())
    const snapshot = await db.collection(HEALTH_COLLECTION).doc(HEALTH_DOC).get()
    const data = snapshot.data()
    if (!data) return EMPTY_HEALTH_STATS
    const counts =
      data.counts && typeof data.counts === 'object' && !Array.isArray(data.counts)
        ? (data.counts as Record<string, number>)
        : {}
    const events = Array.isArray(data.events) ? (data.events as RawHealthEvent[]) : []
    const timing = Array.isArray(data.timing) ? (data.timing as TimingSample[]) : []
    return { counts, events, timing }
  } catch {
    return EMPTY_HEALTH_STATS
  }
}
