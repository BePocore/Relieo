import { getAuth } from 'firebase-admin/auth'
import {
  adminApp,
  hasFirebaseAdmin,
  verifyRequestUser,
} from '../../server/firebaseAdmin.js'
import { readModeration } from '../../server/moderation.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Acquittement d'une suppression de compte : l'utilisateur a vu le message, on
// désactive son compte Firebase (reconnexion impossible, email réservé donc
// recréation impossible). Idempotent : ne fait rien si le compte n'est pas en
// état « deleted ». Appelé par l'écran de suppression côté portail.
export async function POST(request: Request) {
  if (!hasFirebaseAdmin()) {
    return Response.json(
      { message: 'Service indisponible.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  const user = await verifyRequestUser(request)
  if (!user) {
    return Response.json(
      { message: 'Connexion requise.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const moderation = await readModeration(user.uid)
    if (moderation.status === 'deleted') {
      await getAuth(adminApp()).updateUser(user.uid, { disabled: true })
    }
    return Response.json({ ok: true }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ACCOUNT_FINALIZE_FAILED',
        message: error instanceof Error ? error.message : 'Opération impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
