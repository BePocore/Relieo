import { r2GetText, r2PutText } from './r2.js'

// Suivi de la consommation d'emails Resend. On ne tient pas notre propre compteur :
// Resend renvoie l'usage RÉEL du compte (transactionnel + marketing) dans les
// en-têtes de chaque réponse d'envoi (`x-resend-daily-quota`,
// `x-resend-monthly-quota`). On en garde le dernier instantané dans R2, lu par la
// console admin. La valeur se rafraîchit donc à chaque envoi de l'app.
const usagePath = 'relieo/email-usage.json'

// Limites du plan gratuit Resend (affichées comme plafonds dans la console).
export const EMAIL_DAILY_LIMIT = 100
export const EMAIL_MONTHLY_LIMIT = 3000

export type EmailUsage = {
  dailyUsed: number | null
  monthlyUsed: number | null
  updatedAt: string
}

export const readEmailUsage = async (): Promise<EmailUsage | null> => {
  const body = await r2GetText(usagePath)
  if (!body) return null
  try {
    const value = JSON.parse(body) as Partial<EmailUsage>
    return {
      dailyUsed: typeof value.dailyUsed === 'number' ? value.dailyUsed : null,
      monthlyUsed: typeof value.monthlyUsed === 'number' ? value.monthlyUsed : null,
      updatedAt:
        typeof value.updatedAt === 'string'
          ? value.updatedAt
          : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

// Best-effort : un échec d'écriture ne doit jamais casser l'envoi d'un email.
export const recordEmailUsage = async (
  dailyUsed: number | null,
  monthlyUsed: number | null,
): Promise<void> => {
  try {
    const usage: EmailUsage = {
      dailyUsed,
      monthlyUsed,
      updatedAt: new Date().toISOString(),
    }
    await r2PutText(usagePath, JSON.stringify(usage), undefined, {
      skipQuota: true,
    })
  } catch {
    // Suivi best-effort : on ignore les erreurs d'écriture.
  }
}
