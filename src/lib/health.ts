// Monitoring client maison (2026-07-20) : voir server/health.ts pour le
// pourquoi. Trois signaux, tous best-effort et anonymes (aucun identifiant
// visiteur) : erreurs JS globales, voile de chargement bloqué (état exact),
// temps de chargement réel. Même endpoint que le tuto (`POST /api/project`,
// action différenciée) pour ne pas créer de 13e fonction serverless.

export type HealthEventType =
  | 'js-error'
  | 'unhandled-rejection'
  | 'render-error'
  | 'veil-stuck'

export type HealthRoute = 'consult' | 'studio' | 'portal'

export const currentHealthRoute = (): HealthRoute => {
  const params = new URLSearchParams(window.location.search)
  const isStudio = params.get('mode') === 'studio' || window.location.hash === '#studio'
  if (isStudio) return 'studio'
  if (params.has('m') || params.has('code')) return 'consult'
  return 'portal'
}

const connectionType = (): string | undefined => {
  const connection = (
    navigator as { connection?: { effectiveType?: string } }
  ).connection
  return connection?.effectiveType
}

const post = (payload: Record<string, unknown>): void => {
  try {
    void fetch('/api/project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Monitoring secondaire : jamais bloquant pour le visiteur.
  }
}

// Anti-avalanche : une boucle d'erreurs (ex. un rendu qui replante en continu)
// ne doit pas spammer l'endpoint ni gonfler le buffer serveur d'un seul incident.
const MAX_EVENTS_PER_SESSION = 20
let sentThisSession = 0

export function reportHealthEvent(
  type: HealthEventType,
  fields: {
    message?: string
    stack?: string
    detail?: Record<string, unknown>
  } = {},
): void {
  if (sentThisSession >= MAX_EVENTS_PER_SESSION) return
  sentThisSession += 1
  post({
    action: 'health',
    kind: 'event',
    type,
    route: currentHealthRoute(),
    ...fields,
  })
}

export function reportHealthTiming(
  ms: number,
  outcome: 'ready' | 'failed' = 'ready',
): void {
  post({
    action: 'health',
    kind: 'timing',
    ms,
    route: currentHealthRoute(),
    connection: connectionType(),
    outcome,
  })
}

// Écoute globale des erreurs non attrapées par un composant React (scripts,
// event handlers hors rendu). À installer une fois, tôt (main.tsx).
export function installHealthMonitoring(): void {
  window.addEventListener('error', (event) => {
    reportHealthEvent('js-error', {
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    reportHealthEvent('unhandled-rejection', {
      message:
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'Rejet sans message',
      stack: reason instanceof Error ? reason.stack : undefined,
    })
  })
}
