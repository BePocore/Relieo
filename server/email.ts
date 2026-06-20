import { Resend } from 'resend'

// Service d'envoi d'emails (Resend). Tout est volontairement tolérant aux pannes :
// un email est secondaire (les notifications restent in-app), il ne doit jamais
// faire échouer l'action principale. Tant que `RESEND_API_KEY` n'est pas définie,
// `emailConfigured()` est faux et l'appelant retombe sur son comportement par
// défaut (ex. l'envoi natif de Firebase pour la vérification d'adresse).
const apiKey = process.env.RESEND_API_KEY?.trim()
const FROM = process.env.EMAIL_FROM?.trim() || 'Relieo <noreply@relieo.fr>'

let client: Resend | null = null
const resend = (): Resend => {
  if (!client) client = new Resend(apiKey)
  return client
}

export const emailConfigured = (): boolean => Boolean(apiKey)

export type OutgoingEmail = {
  to: string
  subject: string
  html: string
}

// Renvoie true si l'envoi a réussi, false sinon (clé absente, domaine non
// vérifié, erreur réseau...). Ne jette jamais.
export const sendEmail = async (email: OutgoingEmail): Promise<boolean> => {
  if (!apiKey) return false
  try {
    const { error } = await resend().emails.send({
      from: FROM,
      to: email.to,
      subject: email.subject,
      html: email.html,
    })
    if (error) {
      console.error('Resend send error:', error)
      return false
    }
    return true
  } catch (sendError) {
    console.error(
      'Resend send failed:',
      sendError instanceof Error ? sendError.message : sendError,
    )
    return false
  }
}
