// Côté client : demande de ticket d'accès aux médias (le serveur pose un cookie
// httpOnly `.relieo.fr` renvoyé automatiquement aux requêtes media.relieo.fr).
//
//  - { code }              : une carte (consultation publique ou Studio)
//  - { code, accessCode }  : carte protégée — le code d'accès est validé serveur
//  - { scope: 'user' }     : toutes les cartes de l'utilisateur (dashboard)
//  - { scope: 'all' }      : tout (admin)

export type TicketRequest =
  | { code: string; accessCode?: string }
  | { scope: 'user' | 'all' }

// Renvoie le délai de rafraîchissement conseillé (ms), ou null si échec.
export const requestMediaTicket = async (
  req: TicketRequest,
  authToken?: string | null,
): Promise<number | null> => {
  try {
    const response = await fetch('/api/media-ticket', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(req),
      cache: 'no-store',
    })
    if (!response.ok) return null
    const data = (await response.json()) as { refreshInMs?: number }
    return typeof data.refreshInMs === 'number' ? data.refreshInMs : 60_000
  } catch {
    return null
  }
}

// Boucle de renouvellement (~mi-vie du ticket). `getToken` est rappelé à chaque
// tour pour re-signer en Studio/dashboard (jeton Firebase). Renvoie un arrêt.
export const startMediaTicketRefresh = (
  req: TicketRequest,
  getToken?: () => Promise<string | null>,
  intervalMs = 60_000,
): (() => void) => {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async (): Promise<void> => {
    if (stopped) return
    const token = getToken ? await getToken().catch(() => null) : null
    await requestMediaTicket(req, token)
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }
  timer = setTimeout(() => void tick(), intervalMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
