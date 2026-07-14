// Mémoire locale du tuto de consultation (visiteur ANONYME, pas de serveur).
//
// On retient dans le navigateur qu'un visiteur a déjà vu le guide récemment :
// dans la fenêtre (30 jours) on ne le réaffiche pas ; passé ce délai, on
// retraite le navigateur comme un nouveau venu et on le remontre. Un
// « Ne plus afficher » pose un opt-out permanent sur ce navigateur.

const SEEN_KEY = 'relieo.consult.tuto.seenAt' // timestamp ms de la dernière vue
const NEVER_KEY = 'relieo.consult.tuto.never' // '1' = ne plus jamais afficher

/** Fenêtre de silence : au-delà, on retraite comme une nouvelle personne. */
export const CONSULT_TUTORIAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 // 30 jours

const canUseStorage = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

/** Faut-il proposer le tuto de consultation à ce navigateur maintenant ? */
export function shouldShowConsultTutorial(now: number = Date.now()): boolean {
  if (!canUseStorage()) return false
  try {
    if (window.localStorage.getItem(NEVER_KEY) === '1') return false
    const raw = window.localStorage.getItem(SEEN_KEY)
    if (!raw) return true
    const seenAt = Number(raw)
    if (!Number.isFinite(seenAt)) return true
    return now - seenAt >= CONSULT_TUTORIAL_WINDOW_MS
  } catch {
    return false
  }
}

/** Marque le tuto comme vu : réaffiché seulement après la fenêtre de silence. */
export function markConsultTutorialSeen(now: number = Date.now()): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(SEEN_KEY, String(now))
  } catch {
    // mode privé / quota plein : tant pis, on retentera au prochain chargement.
  }
}

/** « Ne plus afficher » : opt-out permanent sur ce navigateur. */
export function dismissConsultTutorialForever(now: number = Date.now()): void {
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(NEVER_KEY, '1')
    window.localStorage.setItem(SEEN_KEY, String(now))
  } catch {
    // idem : sans stockage, on ne peut rien mémoriser.
  }
}
