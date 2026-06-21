import { isAdminUser } from '../server/admin.js'
import { verifyRequestUser } from '../server/firebaseAdmin.js'
import { readHikeIndex } from '../server/hikeIndex.js'
import { trailFolder, trailLocation } from '../server/trailStorage.js'
import {
  buildTicketCookie,
  mintTicket,
  TICKET_TTL_MS,
  type TicketRole,
} from '../server/mediaTicket.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// POST /api/media-ticket  { code }
//
// Delivre un ticket d'acces aux medias d'une carte. Le Worker "videur"
// (media.relieo.fr) verifiera ce ticket a chaque requete de fichier.
//
//  - Brouillon : ticket seulement au proprietaire connecte (ou admin).
//  - Publiee   : ticket a quiconque fournit le bon code (= preuve d'acces ;
//                un mauvais code ne resout aucune carte -> 404).
//  - Publique (future bibliotheque sans code) : pas encore ; la place est laissee
//    via le role et l'index (il suffira d'un statut/flag dedie).
export async function POST(request: Request) {
  const secret = process.env.MEDIA_TICKET_SECRET
  if (!secret) {
    return Response.json(
      { message: 'MEDIA_TICKET_SECRET n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  let code: string | undefined
  try {
    const body = (await request.json()) as { code?: unknown }
    code = typeof body.code === 'string' ? body.code.trim() : undefined
  } catch {
    code = undefined
  }
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
  // Carte introuvable = mauvais code. 404 sans rien reveler.
  if (!entry) {
    return Response.json(
      { message: 'Carte introuvable.' },
      { status: 404, headers: jsonHeaders },
    )
  }

  const user = await verifyRequestUser(request)
  const isOwner = Boolean(user && entry.ownerId && user.uid === entry.ownerId)
  const isAdmin = isAdminUser(user)

  // Brouillon : reserve au proprietaire connecte ou a l'admin (meme regle que
  // GET /api/project). 404 pour ne pas reveler l'existence du brouillon.
  if (entry.status === 'draft' && !isOwner && !isAdmin) {
    return Response.json(
      { message: 'Carte introuvable.' },
      { status: 404, headers: jsonHeaders },
    )
  }

  const role: TicketRole = isOwner || isAdmin ? 'owner' : 'public'
  // Tous les medias de la carte vivent sous ce prefixe ; le slash final evite la
  // collision entre des dossiers comme "halsa" et "halsa-2".
  const prefix = `${trailLocation(entry.ownerId, code).prefix}/`
  const session = crypto.randomUUID()
  const exp = Date.now() + TICKET_TTL_MS

  const token = await mintTicket({ prefix, role, session, exp }, secret)

  const headers = new Headers(jsonHeaders)
  const domain = process.env.MEDIA_COOKIE_DOMAIN ?? '.relieo.fr'
  headers.append('Set-Cookie', buildTicketCookie(token, domain))

  // Exposition du jeton dans le corps : DEV uniquement (test par en-tete
  // X-Media-Ticket cote Worker). Defait le httpOnly -> jamais "1" en prod.
  const exposeToken = process.env.MEDIA_TICKET_EXPOSE_TOKEN === '1'

  return Response.json(
    {
      ok: true,
      role,
      ttlMs: TICKET_TTL_MS,
      // Le client renouvelle a mi-vie (avec marge) tant que la carte reste ouverte.
      refreshInMs: Math.floor(TICKET_TTL_MS / 2),
      ...(exposeToken ? { token } : {}),
    },
    { headers },
  )
}
