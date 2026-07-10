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
import { canServe, enqueueForScan } from './moderation'
import { handleVideoCallback, runScan, runScheduledScan, type ModerationEnv } from './scan'

// Env du videur = config d'accès media + toute la config de modération (ModerationEnv).
// MEDIA_BUCKET et les MODERATION_* (dont MODERATION_ENFORCE : "1" active le blocage fail-closed,
// "0" par défaut tant que le scan + le seed Halsa ne sont pas en place) viennent de ModerationEnv.
export interface Env extends ModerationEnv {
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
  // Toujours present : le cache doit differencier les reponses selon l'Origin,
  // sinon une reponse "no-cors" mise en cache (sans ACAO) casse une requete
  // "cors" ulterieure sur la meme URL (cas du canvas / miniatures).
  headers.set('Vary', 'Origin')
  const origin = request.headers.get('Origin')
  if (!origin) return headers
  const allowed = (env.ALLOWED_ORIGINS ?? '*').split(',').map((value) => value.trim())
  if (allowed.includes('*') || allowed.includes(origin)) {
    // Avec credentials (cookie), impossible de renvoyer "*" : on reflete l'origine.
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Credentials', 'true')
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

// Cache PUBLIC (CDN + navigateur) pour les objets deliberement publics.
const PUBLIC_CACHE_CONTROL = 'public, max-age=3600'

// --- Objets publics (couvertures des cartes) -----------------------------
// `relieo/public/...` est un espace VOLONTAIREMENT public : il ne contient que
// les couvertures des cartes publiees, mises en miroir cote serveur. On les sert
// SANS ticket et SANS controle de moderation (chemin dedie, jamais du contenu
// prive : le contenu des cartes reste sous `relieo/users/...`, protege par ticket).
const servePublicObject = async (
  request: Request,
  env: Env,
  key: string,
): Promise<Response> => {
  if (request.method === 'HEAD') {
    const head = await env.MEDIA_BUCKET.head(key)
    if (!head) return notFound(request, env)
    const headers = corsHeaders(request, env)
    head.writeHttpMetadata(headers)
    headers.set('etag', head.httpEtag)
    headers.set('Cache-Control', PUBLIC_CACHE_CONTROL)
    headers.set('Content-Length', String(head.size))
    return new Response(null, { status: 200, headers })
  }
  const object = await env.MEDIA_BUCKET.get(key)
  if (!object) return notFound(request, env)
  const headers = corsHeaders(request, env)
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('Cache-Control', PUBLIC_CACHE_CONTROL)
  headers.set('Content-Length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}

// --- Endpoints de moderation (hors flux media) ---------------------------
// POST /_moderation/scan?token=<MODERATION_SIGNAL_SECRET>      -> lance un passage de scan
//      (body optionnel { ids: [...] } pour prioriser les medias d'une publication)
// POST /_moderation/callback?token=<MODERATION_CALLBACK_SECRET> -> recoit un callback video Sightengine
// Premiere barriere : un token secret en query (l'URL est connue de nous seuls). La signature
// Sightengine du callback pourra etre verifiee en complement plus tard.

const handleModerationRoute = async (
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  if (url.pathname === '/_moderation/scan') {
    if (!env.MODERATION_SIGNAL_SECRET || url.searchParams.get('token') !== env.MODERATION_SIGNAL_SECRET) {
      return new Response('Forbidden', { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown }
    if (Array.isArray(body.ids)) {
      const ids = body.ids.filter((id): id is string => typeof id === 'string')
      if (ids.length) await enqueueForScan(env.MEDIA_BUCKET, ids)
    }
    const report = await runScan(env)
    return Response.json(report)
  }

  if (url.pathname === '/_moderation/callback') {
    if (!env.MODERATION_CALLBACK_SECRET || url.searchParams.get('token') !== env.MODERATION_CALLBACK_SECRET) {
      return new Response('Forbidden', { status: 403 })
    }
    const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (payload) await handleVideoCallback(env, payload)
    return new Response('ok') // 2xx pour accuser reception (callbacks idempotents)
  }

  return new Response('Not Found', { status: 404 })
}

// --- Handler -------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // Endpoints de moderation (scan / callback video), hors flux media.
    if (url.pathname.startsWith('/_moderation/')) {
      return handleModerationRoute(request, url, env)
    }

    if (request.method === 'OPTIONS') return handlePreflight(request, env)
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const key = keyFromPath(url.pathname)
    if (!key) return forbidden(request, env, 'cle invalide')

    // Espace public (couvertures des cartes publiees) : servi sans ticket.
    if (key.startsWith('relieo/public/')) {
      return servePublicObject(request, env, key)
    }

    const rawTicket = readTicket(request, env)
    if (!rawTicket) return forbidden(request, env, 'ticket absent')

    const ticket = await verifyTicket(rawTicket, env.MEDIA_TICKET_SECRET)
    if (!ticket) return forbidden(request, env, 'ticket invalide ou expire')

    // Un ticket n'ouvre QUE les medias de sa carte (son prefixe R2).
    if (!key.startsWith(ticket.prefix)) {
      return forbidden(request, env, 'cle hors perimetre du ticket')
    }

    // Moderation IA : un media non valide est refuse ici (fail-closed cote public). Le visiteur
    // ne voit que le scanne & non flagge ; le proprietaire/admin voit tout sauf le rejete.
    // Tant que MODERATION_ENFORCE !== "1", on sert tout (deploiement progressif sans casser la prod).
    // Exception : les fichiers de traces GPS (JSON de points sous /traces/, pas des medias) ne
    // passent jamais au scan -> ils sont exemptes du controle de moderation. Le ticket, lui,
    // reste obligatoire (verifie ci-dessus). On exempte TOUT ce qui vit sous /traces/ quelle que
    // soit l'extension : cote client, le blob de trace est nomme `<empreinte>.jpg` (Blob sans nom),
    // donc un test sur `.json` laissait passer ces fichiers dans le scan -> 403 pour le public.
    const isTraceFile = key.includes('/traces/')
    const enforce = env.MODERATION_ENFORCE === '1'
    if (!isTraceFile && !(await canServe(env.MEDIA_BUCKET, key, ticket.role, enforce))) {
      return forbidden(request, env, 'media indisponible (moderation)')
    }

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

  // Cron toutes les 3 h (cf. wrangler.jsonc triggers.crons) : balayage de fond de la modération.
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduledScan(env))
  },
} satisfies ExportedHandler<Env>
