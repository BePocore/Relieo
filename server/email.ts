import { recordEmailUsage } from './emailUsage.js'

// Service d'envoi d'emails (Resend), via appel HTTP direct (pas le SDK) pour
// pouvoir lire les en-têtes de quota renvoyés par Resend. Tolérant aux pannes :
// un email est secondaire (les notifications restent in-app), il ne doit jamais
// faire échouer l'action principale. Tant que `RESEND_API_KEY` n'est pas définie,
// `emailConfigured()` est faux et l'appelant retombe sur son comportement par
// défaut (ex. l'envoi natif de Firebase pour la vérification d'adresse).
const apiKey = process.env.RESEND_API_KEY?.trim()
const FROM = process.env.EMAIL_FROM?.trim() || 'Relieo <noreply@relieo.fr>'

export const emailConfigured = (): boolean => Boolean(apiKey)

export type OutgoingEmail = {
  to: string
  subject: string
  html: string
}

const parseQuota = (value: string | null): number | null => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

// Renvoie true si l'envoi a réussi, false sinon (clé absente, domaine non
// vérifié, erreur réseau...). Ne jette jamais.
export const sendEmail = async (email: OutgoingEmail): Promise<boolean> => {
  if (!apiKey) return false
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: FROM,
        to: [email.to],
        subject: email.subject,
        html: email.html,
      }),
    })

    if (response.ok) {
      // Resend renvoie l'usage RÉEL du compte dans les en-têtes : on le capture.
      await recordEmailUsage(
        parseQuota(response.headers.get('x-resend-daily-quota')),
        parseQuota(response.headers.get('x-resend-monthly-quota')),
      )
      return true
    }

    const detail = await response.text().catch(() => '')
    console.error('Resend send error:', response.status, detail)
    return false
  } catch (sendError) {
    console.error(
      'Resend send failed:',
      sendError instanceof Error ? sendError.message : sendError,
    )
    return false
  }
}
