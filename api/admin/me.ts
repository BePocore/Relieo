import { hasFirebaseAdmin, verifyRequestUser } from '../../server/firebaseAdmin.js'
import { isAdminUser } from '../../server/admin.js'
import { resolveAccountType } from '../../server/roles.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Identité du compte connecté : `admin` (afficher ou non la console — l'autorisation
// réelle est revérifiée sur chaque endpoint admin) et `accountType` (viewer par
// défaut / creator). Appelé à chaque login par le portail pour router l'accueil.
export async function GET(request: Request) {
  if (!hasFirebaseAdmin()) {
    return Response.json(
      { admin: false, accountType: 'viewer' },
      { headers: jsonHeaders },
    )
  }
  const user = await verifyRequestUser(request)
  if (!user) {
    return Response.json(
      { admin: false, accountType: 'viewer' },
      { headers: jsonHeaders },
    )
  }
  return Response.json(
    { admin: isAdminUser(user), accountType: resolveAccountType(user.uid) },
    { headers: jsonHeaders },
  )
}
