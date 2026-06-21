// Signature des tickets d'acces media (HMAC-SHA256), cote EMETTEUR (Vercel).
// DOIT rester en phase avec worker/src/ticket.ts : c'est le Worker "videur" qui
// verifiera ces jetons (meme format, meme secret MEDIA_TICKET_SECRET). Web Crypto
// pur (fourni par Node sur Vercel) pour rester identique au runtime Worker.
//
// Format du jeton : base64url(payloadJSON) + "." + base64url(hmac)

export type TicketRole = 'public' | 'owner'

export interface TicketPayload {
  /** Prefixe R2 autorise, ex: "relieo/users/<uid>/randonnees/<folder>/". */
  prefix: string
  /** Role du porteur (owner verra plus tard ses medias non encore scannes). */
  role: TicketRole
  /** Identifiant de session navigateur (base du renfort anti-copie). */
  session: string
  /** Expiration en epoch ms. */
  exp: number
}

export const TICKET_COOKIE = 'relieo_media_ticket'
export const TICKET_TTL_MS = 120_000 // 2 minutes

const enc = new TextEncoder()

const b64urlEncode = (bytes: Uint8Array): string => {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const sign = async (data: string, secret: string): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return new Uint8Array(signature)
}

/** Cree un ticket signe : base64url(payload).base64url(hmac). */
export const mintTicket = async (
  payload: TicketPayload,
  secret: string,
): Promise<string> => {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)))
  const signature = b64urlEncode(await sign(body, secret))
  return `${body}.${signature}`
}

// En-tete Set-Cookie pour le ticket. Cookie technique strictement necessaire
// (acces/securite) -> exempte de bandeau de consentement RGPD/ePrivacy.
// Domain=.relieo.fr pour qu'il parte automatiquement vers media.relieo.fr
// (meme site). En dev (localhost), passer domain='' pour un cookie host-only.
export const buildTicketCookie = (
  token: string,
  domain = '.relieo.fr',
  maxAgeSec = Math.floor(TICKET_TTL_MS / 1000),
): string => {
  const parts = [
    `${TICKET_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ]
  if (domain) parts.splice(1, 0, `Domain=${domain}`)
  return parts.join('; ')
}
