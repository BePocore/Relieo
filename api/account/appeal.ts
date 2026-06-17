import { hasFirebaseAdmin, verifyRequestUser } from '../../server/firebaseAdmin.js'
import { hasR2Config } from '../../server/r2.js'
import { appendAppeal, readModeration } from '../../server/moderation.js'
import { appendAdminNotification } from '../../server/adminNotifications.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Message d'appel d'un utilisateur banni vers l'admin (1 seul par bannissement).
export async function POST(request: Request) {
  if (!hasFirebaseAdmin() || !hasR2Config()) {
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
    const body = (await request.json()) as { message?: string }
    const message = body.message?.trim()
    if (!message) {
      return Response.json(
        { message: 'Le message est vide.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const moderation = await readModeration(user.uid)
    if (moderation.status !== 'blocked') {
      return Response.json(
        { message: 'Aucun bannissement en cours.' },
        { status: 403, headers: jsonHeaders },
      )
    }

    const stored = await appendAppeal(user.uid, message)
    if (!stored) {
      return Response.json(
        { message: 'Vous avez déjà envoyé un message pour ce bannissement.' },
        { status: 409, headers: jsonHeaders },
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

    return Response.json({ ok: true }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ACCOUNT_APPEAL_FAILED',
        message: error instanceof Error ? error.message : 'Envoi impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
