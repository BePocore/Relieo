import { getAuth } from 'firebase-admin/auth'
import {
  adminApp,
  decodeRequestUser,
  hasFirebaseAdmin,
  verifyRequestUser,
} from '../server/firebaseAdmin.js'
import { hasR2Config } from '../server/r2.js'
import { appendAppeal, readModeration, setModeration } from '../server/moderation.js'
import { setAccountCreator } from '../server/firestoreAdmin.js'
import { appendAdminNotification } from '../server/adminNotifications.js'
import { emailConfigured, sendEmail } from '../server/email.js'
import { verificationEmailHtml } from '../server/emailTemplates.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: jsonHeaders })

type AccountBody = {
  action?:
    | 'appeal'
    | 'finalize-deletion'
    | 'request-deletion'
    | 'send-verification'
    | 'become-creator'
  message?: string
  plan?: string
}

// Forfaits connus (doit rester aligné sur src/portal/plans.ts). Seul Standard est
// réellement disponible ; un id inconnu retombe sur Standard.
const KNOWN_PLANS = ['standard', 'explorateur', 'cartographe']

// Endpoint compte de l'utilisateur connecté. Aiguille sur `action` :
// - appeal : message d'appel d'un banni (1 par bannissement).
// - finalize-deletion : désactive un compte supprimé (reconnexion impossible,
//   email réservé).
// - request-deletion : demande volontaire de suppression (notifie l'admin).
export async function POST(request: Request) {
  if (!hasFirebaseAdmin()) {
    return json({ message: 'Service indisponible.' }, 503)
  }

  const body = (await request.json().catch(() => ({}))) as AccountBody

  try {
    // Envoi du mail de vérification : accessible à un compte tout juste créé,
    // donc on décode le token SANS exiger email_verified. Si Resend n'est pas
    // configuré (ou échoue), on renvoie `fallback` pour que le client retombe
    // sur l'envoi natif de Firebase. Zéro régression tant que la clé manque.
    if (body.action === 'send-verification') {
      const account = await decodeRequestUser(request)
      if (!account || !account.email) {
        return json({ message: 'Connexion requise.' }, 401)
      }
      if (account.emailVerified) {
        return json({ alreadyVerified: true })
      }
      if (!emailConfigured()) {
        return json({ sent: false, fallback: true })
      }
      const link = await getAuth(adminApp()).generateEmailVerificationLink(
        account.email,
      )
      const sent = await sendEmail({
        to: account.email,
        subject: 'Confirmez votre adresse pour Relieo',
        html: verificationEmailHtml(link),
      })
      return json({ sent, fallback: !sent })
    }

    const user = await verifyRequestUser(request)
    if (!user) {
      return json({ message: 'Connexion requise.' }, 401)
    }

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

    if (body.action === 'become-creator') {
      // Passage viewer -> créateur : le rôle est posé UNIQUEMENT ici (Admin SDK),
      // jamais par le client. Refusé pour un compte non actif (sanctionné).
      if (!hasR2Config()) return json({ message: 'Service indisponible.' }, 503)
      const moderation = await readModeration(user.uid)
      if (moderation.status !== 'active') {
        return json({ message: 'Action indisponible pour ce compte.' }, 403)
      }
      const plan = KNOWN_PLANS.includes(body.plan ?? '') ? body.plan! : 'standard'
      await setAccountCreator(user.uid, plan)
      return json({ ok: true, plan })
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
