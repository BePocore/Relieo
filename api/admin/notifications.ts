import { hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import { hasR2Config } from '../../server/r2.js'
import {
  markAdminNotificationsRead,
  readAdminNotifications,
} from '../../server/adminNotifications.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

const guard = async (request: Request) => {
  if (!hasFirebaseAdmin() || !hasR2Config()) {
    return Response.json(
      { message: 'Firebase Admin et Cloudflare R2 sont requis.' },
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
  return null
}

// Notifications admin (ex : messages d'appel des utilisateurs bannis).
export async function GET(request: Request) {
  const denied = await guard(request)
  if (denied) return denied
  try {
    const notifications = await readAdminNotifications()
    return Response.json({ notifications }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_NOTIFICATIONS_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture des notifications impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}

// Marque des notifications comme lues.
export async function POST(request: Request) {
  const denied = await guard(request)
  if (denied) return denied
  try {
    const body = (await request.json()) as { ids?: string[] }
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : []
    if (ids.length > 0) await markAdminNotificationsRead(ids)
    return Response.json({ ok: true }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_NOTIFICATIONS_READ_FAILED',
        message:
          error instanceof Error ? error.message : 'Mise à jour impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
