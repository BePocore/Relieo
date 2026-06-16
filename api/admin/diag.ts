import { getAuth } from 'firebase-admin/auth'
import {
  adminApp,
  firebaseAdminDiagnostics,
  hasFirebaseAdmin,
} from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Diagnostic admin : état de la config Firebase Admin (sans exposer la clé) +
// test réel de génération d'un jeton OAuth2 (la cause des erreurs DECODER).
export async function GET(request: Request) {
  if (!hasFirebaseAdmin()) {
    return Response.json(
      { configured: false, message: 'Firebase Admin non configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  const admin = await requireAdmin(request)
  if (!admin) {
    return Response.json(
      { message: 'Accès réservé à l’administrateur.' },
      { status: 403, headers: jsonHeaders },
    )
  }

  const diagnostics = firebaseAdminDiagnostics()
  let mintToken: string
  try {
    // listUsers force la génération d'un jeton OAuth2 à partir de la clé privée
    // (le point qui échoue en cas de clé mal formée).
    await getAuth(adminApp()).listUsers(1)
    mintToken = 'ok'
  } catch (error) {
    mintToken = error instanceof Error ? error.message : 'erreur inconnue'
  }

  return Response.json({ ...diagnostics, mintToken }, { headers: jsonHeaders })
}
