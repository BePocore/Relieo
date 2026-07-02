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
const dec = new TextDecoder()

const b64urlEncode = (bytes: Uint8Array): string => {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const b64urlDecode = (text: string): Uint8Array => {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
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

const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

// Vérifie signature + expiration d'un ticket (miroir de worker/src/ticket.ts,
// même secret MEDIA_TICKET_SECRET). Renvoie le payload si valide, sinon null.
// Sert côté Vercel à traiter le cookie ticket comme PREUVE D'ACCÈS (une carte
// protégée n'a un ticket que si son code a été validé par /api/media-ticket).
export const verifyTicket = async (
  token: string,
  secret: string,
): Promise<TicketPayload | null> => {
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const signaturePart = token.slice(dot + 1)
  let expected: Uint8Array
  let given: Uint8Array
  try {
    expected = await sign(body, secret)
    given = b64urlDecode(signaturePart)
  } catch {
    return null
  }
  if (!timingSafeEqual(expected, given)) return null
  let payload: TicketPayload
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body))) as TicketPayload
  } catch {
    return null
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
  if (typeof payload.prefix !== 'string' || payload.prefix.length === 0) return null
  if (payload.role !== 'public' && payload.role !== 'owner') return null
  return payload
}

// Empreinte du code d'accès : SHA-256 de `<salt>:<code>` (salt = slug de la
// carte, pour que deux cartes au même code aient des empreintes différentes).
// On ne stocke jamais le code en clair.
export const hashAccessCode = async (
  code: string,
  salt: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`${salt}:${code}`),
  )
  return b64urlEncode(new Uint8Array(digest))
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
