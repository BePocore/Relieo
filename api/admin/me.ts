import { hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Indique au client si l'utilisateur connecté est admin (pour afficher ou non
// l'entrée Admin). L'autorisation réelle est revérifiée sur chaque endpoint.
export async function GET(request: Request) {
  if (!hasFirebaseAdmin()) {
    return Response.json({ admin: false }, { headers: jsonHeaders })
  }
  const admin = await requireAdmin(request)
  return Response.json({ admin: Boolean(admin) }, { headers: jsonHeaders })
}
