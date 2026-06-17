import { getAuth } from 'firebase-admin/auth'
import {
  adminApp,
  hasFirebaseAdmin,
  verifyRequestUser,
} from '../server/firebaseAdmin.js'
import { hasR2Config } from '../server/r2.js'
import { appendAppeal, readModeration, setModeration } from '../server/moderation.js'
import { appendAdminNotification } from '../server/adminNotifications.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: jsonHeaders })

type AccountBody = {
  action?: 'appeal' | 'finalize-deletion' | 'request-deletion'
  message?: string
}

// Endpoint compte de l'utilisateur connecté. Aiguille sur `action` :
// - appeal : message d'appel d'un banni (1 par bannissement).
// - finalize-deletion : désactive un compte supprimé (reconnexion impossible,
//   email réservé).
// - request-deletion : demande volontaire de suppression (notifie l'admin).
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
      // Id partagé entre la notification admin et l'appel (lien pour la réponse).
      const notifId = `${user.uid}-appeal-${Date.now()}`
      const stored = await appendAppeal(user.uid, message, notifId)
      if (!stored) {
        return json(
          { message: 'Vous avez déjà envoyé un message pour ce bannissement.' },
          409,
        )
      }
      await appendAdminNotification({
        id: notifId,
        type: 'appeal',
        fromUid: user.uid,
        fromEmail: user.email,
        message,
        createdAt: new Date().toISOString(),
        read: false,
        reply: null,
      })
      return json({ ok: true })
    }

    if (body.action === 'request-deletion') {
      if (!hasR2Config()) return json({ message: 'Service indisponible.' }, 503)
      const message = body.message?.trim()
      if (!message) return json({ message: 'Le message est vide.' }, 400)

      const moderation = await readModeration(user.uid)
      if (moderation.status !== 'active') {
        return json({ message: 'Action indisponible pour ce compte.' }, 403)
      }
      if (moderation.deletionRequest) {
        return json(
          { message: 'Une demande de suppression est déjà en cours.' },
          409,
        )
      }
      const requestedAt = new Date().toISOString()
      await setModeration(user.uid, { deletionRequest: { message, requestedAt } })
      await appendAdminNotification({
        id: `${user.uid}-deletion-${Date.now()}`,
        type: 'deletion-request',
        fromUid: user.uid,
        fromEmail: user.email,
        message,
        createdAt: requestedAt,
        read: false,
        reply: null,
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
