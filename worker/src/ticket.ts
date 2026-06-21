// Jeton d'acces media signe (HMAC-SHA256), partage entre l'EMETTEUR (API Vercel
// /api/media-ticket) et le VIDEUR (ce Worker). Le Worker verifie la signature seul,
// sans rappeler Vercel. Code 100% Web Crypto (btoa/atob, crypto.subtle, TextEncoder),
// donc il tourne a l'identique cote Worker et cote Node -> garder les deux copies en
// phase (une copie vivra aussi dans server/ pour l'emission cote Vercel).
//
// Format du jeton : base64url(payloadJSON) + "." + base64url(hmac)

export type TicketRole = 'public' | 'owner'

export interface TicketPayload {
  /** Prefixe R2 autorise, ex: "relieo/users/<uid>/randonnees/<folder>/". */
  prefix: string
  /** Role du porteur (owner verra plus tard ses medias non encore scannes). */
  role: TicketRole
  /** Identifiant de session navigateur (renfort anti-copie de ticket). */
  session: string
  /** Expiration en epoch ms. */
  exp: number
}

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

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

const sign = async (data: string, secret: string): Promise<Uint8Array> => {
  const key = await importKey(secret)
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

// Comparaison a temps constant (evite les timing attacks sur la signature).
const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Verifie la signature ET l'expiration. Renvoie le payload si tout est bon,
 * sinon null (jamais d'exception : un jeton malforme = refus).
 */
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
