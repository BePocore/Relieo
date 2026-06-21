// Le "videur" Relieo : sert les medias R2 UNIQUEMENT avec un ticket valide.
//
//   GET media.relieo.fr/<cle R2>
//     1. lit le ticket (cookie httpOnly, ou en-tete X-Media-Ticket en dev)
//     2. verifie la signature + l'expiration (HMAC, voir ticket.ts)
//     3. verifie que la cle demandee est bien dans le perimetre du ticket (prefixe carte)
//     4. lit l'objet dans R2 (binding natif) et le sert, avec support Range (video) + cache PRIVE
//
// Tant que le bucket reste public (avant la bascule finale), ce Worker tourne "a cote".
// La vraie protection arrive quand le bucket devient prive : l'URL seule ne suffira plus.

import { verifyTicket } from './ticket'

export interface Env {
  MEDIA_BUCKET: R2Bucket
  MEDIA_TICKET_SECRET: string
  /** Origines autorisees pour CORS (CSV). "*" en dev, "https://relieo.fr" en prod. */
  ALLOWED_ORIGINS?: string
  /** "1" autorise le ticket en en-tete X-Media-Ticket (tests sur *.workers.dev). "0" en prod. */
  ALLOW_HEADER_TICKET?: string
}

const TICKET_COOKIE = 'relieo_media_ticket'
// Cache navigateur PRIVE : jamais de cache partage/CDN pour du contenu sous controle d'acces
// (sinon un fichier servi a un autorise pourrait etre resservi sans verification).
const CACHE_CONTROL = 'private, max-age=300'

// --- CORS ----------------------------------------------------------------

const corsHeaders = (request: Request, env: Env): Headers => {
  const headers = new Headers()
  const origin = request.headers.get('Origin')
  if (!origin) return headers
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((value) => value.trim())
  if (allowed.includes('*') || allowed.includes(origin)) {
    // Avec credentials (cookie), impossible de renvoyer "*" : on reflete l'origine.
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Vary', 'Origin')
  }
  return headers
}

const handlePreflight = (request: Request, env: Env): Response => {
  const headers = corsHeaders(request, env)
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  headers.set(
    'Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ?? 'Range, X-Media-Ticket',
  )
  headers.set('Access-Control-Max-Age', '86400')
  return new Response(null, { status: 204, headers })
}

// --- Lecture du ticket ---------------------------------------------------

const readCookie = (request: Request, name: string): string | null => {
  const cookie = request.headers.get('Cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim())
    }
  }
  return null
}

const readTicket = (request: Request, env: Env): string | null => {
  const fromCookie = readCookie(request, TICKET_COOKIE)
  if (fromCookie) return fromCookie
  if (env.ALLOW_HEADER_TICKET === '1') return request.headers.get('X-Media-Ticket')
  return null
}

// --- Cle R2 depuis l'URL -------------------------------------------------

const keyFromPath = (pathname: string): string | null => {
  const raw = pathname.replace(/^\/+/, '')
  if (!raw) return null
  let key: string
  try {
    key = raw.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  // Garde-fou : on ne sert que l'arbre Relieo, jamais de remontee de chemin.
  if (key.includes('..') || !key.startsWith('relieo/')) return null
  return key
}

// --- Range (lecture video par morceaux) ----------------------------------

const parseRange = (header: string | null): R2Range | undefined => {
  if (!header) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return undefined
  const [, startRaw, endRaw] = match
  if (startRaw === '' && endRaw === '') return undefined
  if (startRaw === '') return { suffix: Number(endRaw) }
  const offset = Number(startRaw)
  if (endRaw === '') return { offset }
  return { offset, length: Number(endRaw) - offset + 1 }
}

const forbidden = (request: Request, env: Env, reason: string): Response =>
  new Response(`Forbidden: ${reason}`, { status: 403, headers: corsHeaders(request, env) })

const notFound = (request: Request, env: Env): Response =>
  new Response('Not Found', { status: 404, headers: corsHeaders(request, env) })

// --- Handler -------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return handlePreflight(request, env)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const key = keyFromPath(new URL(request.url).pathname)
    if (!key) return forbidden(request, env, 'cle invalide')

    const rawTicket = readTicket(request, env)
    if (!rawTicket) return forbidden(request, env, 'ticket absent')

    const ticket = await verifyTicket(rawTicket, env.MEDIA_TICKET_SECRET)
    if (!ticket) return forbidden(request, env, 'ticket invalide ou expire')

    // Un ticket n'ouvre QUE les medias de sa carte (son prefixe R2).
    if (!key.startsWith(ticket.prefix)) {
      return forbidden(request, env, 'cle hors perimetre du ticket')
    }

    // TODO (etape moderation) : refuser ici si le media est flagge
    // (lecture de relieo/.../media-moderation.json, mis en cache court cote Worker).

    // HEAD : metadonnees seules, pas de corps.
    if (request.method === 'HEAD') {
      const head = await env.MEDIA_BUCKET.head(key)
      if (!head) return notFound(request, env)
      const headers = corsHeaders(request, env)
      head.writeHttpMetadata(headers)
      headers.set('etag', head.httpEtag)
      headers.set('Accept-Ranges', 'bytes')
      headers.set('Cache-Control', CACHE_CONTROL)
      headers.set('Content-Length', String(head.size))
      return new Response(null, { status: 200, headers })
    }

    const range = parseRange(request.headers.get('Range'))
    const object = await env.MEDIA_BUCKET.get(key, { range })
    if (!object) return notFound(request, env)

    const headers = corsHeaders(request, env)
    object.writeHttpMetadata(headers) // Content-Type, etc. depuis les metadonnees stockees
    headers.set('etag', object.httpEtag)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', CACHE_CONTROL) // ecrase le cache public/immutable d'origine

    if (range && object.range) {
      const resolved = object.range
      const offset = 'offset' in resolved && resolved.offset !== undefined ? resolved.offset : 0
      const length =
        'length' in resolved && resolved.length !== undefined
          ? resolved.length
          : object.size - offset
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`)
      headers.set('Content-Length', String(length))
      return new Response(object.body, { status: 206, headers })
    }

    headers.set('Content-Length', String(object.size))
    return new Response(object.body, { status: 200, headers })
  },
} satisfies ExportedHandler<Env>
