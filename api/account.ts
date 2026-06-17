import { getAuth } from 'firebase-admin/auth'
import {
  adminApp,
  hasFirebaseAdmin,
  verifyRequestUser,
} from '../server/firebaseAdmin.js'
import { hasR2Config } from '../server/r2.js'
import { appendAppeal, readModeration } from '../server/moderation.js'
import { appendAdminNotification } from '../server/adminNotifications.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: jsonHeaders })

type AccountBody = {
  action?: 'appeal' | 'finalize-deletion'
  message?: string
}

// Endpoint compte de l'utilisateur connecté. Aiguille sur `action` :
// - appeal : message d'appel d'un banni (1 par bannissement).
// - finalize-deletion : désactive un compte supprimé (reconnexion impossible,
//   email réservé).
export async function POST(request: Request) {
  if (!hasFirebaseAdmin()) {
    return json({ message: 'Service indisponible.' }, 503)
  }
  const user = await verifyRequestUser(request)
  if (!user) {
    return json({ message: 'Connexion requise.' }, 401)
  }

  try {
    const body = (await request.json().catch(() => ({}))) as AccountBody

    if (body.action === 'finalize-deletion') {
      const moderation = await readModeration(user.uid)
      if (moderation.status === 'deleted') {
        await getAuth(adminApp()).updateUser(user.uid, { disabled: true })
      }
      return json({ ok: true })
    }

    if (body.action === 'appeal') {
      if (!hasR2Config()) return json({ message: 'Service indisponible.' }, 503)
      const message = body.message?.trim()
      if (!message) return json({ message: 'Le message est vide.' }, 400)

      const moderation = await readModeration(user.uid)
      if (moderation.status !== 'blocked') {
        return json({ message: 'Aucun bannissement en cours.' }, 403)
      }
      const stored = await appendAppeal(user.uid, message)
      if (!stored) {
        return json(
          { message: 'Vous avez déjà envoyé un message pour ce bannissement.' },
          409,
        )
      }
      await appendAdminNotification({
        id: `${user.uid}-appeal-${Date.now()}`,
        type: 'appeal',
        fromUid: user.uid,
        fromEmail: user.email,
        message,
        createdAt: new Date().toISOString(),
        read: false,
      })
      return json({ ok: true })
    }

    return json({ message: 'action inconnue.' }, 400)
  } catch (error) {
    return json(
      {
        code: 'ACCOUNT_ACTION_FAILED',
        message: error instanceof Error ? error.message : 'Opération impossible.',
      },
      500,
    )
  }
}
