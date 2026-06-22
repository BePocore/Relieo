import { isAdminUser } from '../server/admin.js'
import { verifyRequestUser } from '../server/firebaseAdmin.js'
import { readHikeIndex } from '../server/hikeIndex.js'
import {
  trailFolder,
  trailLocation,
  userStorageRoot,
} from '../server/trailStorage.js'
import {
  buildTicketCookie,
  mintTicket,
  TICKET_TTL_MS,
  type TicketRole,
} from '../server/mediaTicket.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Fabrique le ticket, le pose en cookie httpOnly et renvoie la réponse.
const respondWithTicket = async (
  prefix: string,
  role: TicketRole,
  secret: string,
): Promise<Response> => {
  const session = crypto.randomUUID()
  const exp = Date.now() + TICKET_TTL_MS
  const token = await mintTicket({ prefix, role, session, exp }, secret)
  const headers = new Headers(jsonHeaders)
  const domain = process.env.MEDIA_COOKIE_DOMAIN ?? '.relieo.fr'
  headers.append('Set-Cookie', buildTicketCookie(token, domain))
  // DEV uniquement : exposer le jeton (test par en-tête). Jamais "1" en prod.
  const exposeToken = process.env.MEDIA_TICKET_EXPOSE_TOKEN === '1'
  return Response.json(
    {
      ok: true,
      role,
      ttlMs: TICKET_TTL_MS,
      refreshInMs: Math.floor(TICKET_TTL_MS / 2),
      ...(exposeToken ? { token } : {}),
    },
    { headers },
  )
}

// POST /api/media-ticket  { code }            → ticket d'UNE carte
//                         { scope: 'user' }   → ticket de TOUTES les cartes de l'appelant
//                         { scope: 'all' }    → ticket de TOUT (admin)
//
// Le Worker « videur » (media.relieo.fr) vérifie ce ticket à chaque requête.
//  - Carte brouillon : ticket seulement au propriétaire connecté (ou admin).
//  - Carte publiée   : ticket à quiconque fournit le bon code.
//  - scope user/all  : pour les dashboards (plusieurs covers de cartes différentes).
export async function POST(request: Request) {
  const secret = process.env.MEDIA_TICKET_SECRET
  if (!secret) {
    return Response.json(
      { message: 'MEDIA_TICKET_SECRET n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  let payload: { code?: unknown; scope?: unknown }
  try {
    payload = (await request.json()) as { code?: unknown; scope?: unknown }
  } catch {
    payload = {}
  }
  const scope = typeof payload.scope === 'string' ? payload.scope : undefined

  // --- Tickets scopés (dashboards) ---------------------------------------
  if (scope === 'user' || scope === 'all') {
    const user = await verifyRequestUser(request)
    if (!user) {
      return Response.json(
        { message: 'Connexion requise.' },
        { status: 401, headers: jsonHeaders },
      )
    }
    if (scope === 'all') {
      if (!isAdminUser(user)) {
        return Response.json(
          { message: 'Accès refusé.' },
          { status: 403, headers: jsonHeaders },
        )
      }
      return respondWithTicket('relieo/', 'owner', secret)
    }
    // scope === 'user' : toutes les cartes de l'utilisateur.
    return respondWithTicket(userStorageRoot(user.uid), 'owner', secret)
  }

  // --- Ticket d'une carte (consultation publique ou Studio) --------------
  const code = typeof payload.code === 'string' ? payload.code.trim() : undefined
  if (!code) {
    return Response.json(
      { message: 'Le code de la carte est requis.' },
      { status: 400, headers: jsonHeaders },
    )
  }

  let folder: string
  try {
    folder = trailFolder(code)
  } catch {
    return Response.json(
      { message: 'Code de carte invalide.' },
      { status: 400, headers: jsonHeaders },
    )
  }

  const entry = (await readHikeIndex()).find((hike) => hike.folder === folder)
  // Carte introuvable = mauvais code. 404 sans rien révéler.
  if (!entry) {
    return Response.json(
      { message: 'Carte introuvable.' },
      { status: 404, headers: jsonHeaders },
    )
  }

  const user = await verifyRequestUser(request)
  const isOwner = Boolean(user && entry.ownerId && user.uid === entry.ownerId)
  const isAdmin = isAdminUser(user)

  // Brouillon : réservé au propriétaire connecté ou à l'admin (même règle que
  // GET /api/project). 404 pour ne pas révéler l'existence du brouillon.
  if (entry.status === 'draft' && !isOwner && !isAdmin) {
    return Response.json(
      { message: 'Carte introuvable.' },
      { status: 404, headers: jsonHeaders },
    )
  }

  const role: TicketRole = isOwner || isAdmin ? 'owner' : 'public'
  // Le slash final évite la collision entre "halsa" et "halsa-2".
  const prefix = `${trailLocation(entry.ownerId, code).prefix}/`
  return respondWithTicket(prefix, role, secret)
}
