import { r2GetText, r2PutText } from './r2.js'
import { appendAdminNotification } from './adminNotifications.js'
import { emailConfigured, sendEmail } from './email.js'

// Alerte de coût mensuel : quand le coût R2 estimé dépasse un seuil, on prévient
// l'admin (notif in-app + email), une seule fois par mois (anti-spam via un
// état R2). L'alerte budgétaire Cloudflare reste le filet automatique permanent.

const STATE_PATH = 'relieo/cost-alerts.json'

// Seuil d'alerte, en euros/mois. Ajustable ici (on pourra en faire un réglage
// d'UI plus tard).
export const COST_ALERT_THRESHOLD_EUR = 5

// Destinataire de l'alerte (compte admin ; contact@relieo.fr y est redirigé).
const ALERT_EMAIL = 'bepocore@gmail.com'

const currentMonth = (): string => new Date().toISOString().slice(0, 7) // YYYY-MM

// À appeler avec le coût mensuel estimé (overview.monthlyCostEur). Best-effort :
// ne jette jamais, une éventuelle erreur ne doit pas casser le dashboard.
export const maybeAlertCostThreshold = async (
  monthlyCostEur: number,
): Promise<void> => {
  try {
    if (monthlyCostEur <= COST_ALERT_THRESHOLD_EUR) return

    const body = await r2GetText(STATE_PATH)
    let lastMonth: string | null = null
    if (body) {
      try {
        lastMonth = (JSON.parse(body) as { month?: string }).month ?? null
      } catch {
        lastMonth = null
      }
    }
    const month = currentMonth()
    if (lastMonth === month) return // déjà alerté ce mois-ci

    const cost = monthlyCostEur.toFixed(2)
    await appendAdminNotification({
      id: `cost-${month}-${Date.now()}`,
      type: 'cost-alert',
      fromUid: 'system',
      fromEmail: null,
      message: `Coût mensuel R2 estimé à ${cost} € : le seuil de ${COST_ALERT_THRESHOLD_EUR} €/mois est dépassé. Ouvre l'onglet Coûts et surveille le stockage des comptes.`,
      createdAt: new Date().toISOString(),
      read: false,
      reply: null,
    })

    if (emailConfigured()) {
      await sendEmail({
        to: ALERT_EMAIL,
        subject: `Relieo : coût mensuel estimé ${cost} € (seuil ${COST_ALERT_THRESHOLD_EUR} €)`,
        html:
          `<p>Le coût mensuel estimé de Relieo a dépassé le seuil de ` +
          `<strong>${COST_ALERT_THRESHOLD_EUR} €/mois</strong>.</p>` +
          `<p>Estimation actuelle : <strong>${cost} €</strong>.</p>` +
          `<p>Ouvre la console admin (onglet Coûts) pour voir le détail et gérer le stockage des comptes.</p>`,
      })
    }

    await r2PutText(
      STATE_PATH,
      JSON.stringify({
        month,
        notifiedAt: new Date().toISOString(),
        costEur: monthlyCostEur,
      }),
    )
  } catch {
    // Best-effort : une alerte manquée ne doit jamais casser la console admin.
  }
}
