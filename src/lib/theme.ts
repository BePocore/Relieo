// Gestion du thème clair / nuit / auto. La préférence est stockée en
// localStorage ; le thème effectif est posé en `data-theme` sur <html>, donc
// tout le site en hérite via les tokens CSS (`src/index.css`). L'admin garde
// ses propres variables et n'est pas affecté.

export type ThemePreference = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'relieo-theme'

const darkQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

export const getThemePreference = (): ThemePreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored
  } catch {
    /* localStorage indisponible */
  }
  return 'auto'
}

// Thème réellement appliqué (auto résolu selon le réglage de l'appareil).
const resolveTheme = (preference: ThemePreference): 'light' | 'dark' => {
  if (preference === 'auto') return darkQuery()?.matches ? 'dark' : 'light'
  return preference
}

// Pose le thème effectif sur <html> pour la préférence donnée (ou la préférence
// enregistrée si aucune n'est fournie).
export const applyTheme = (preference = getThemePreference()): void => {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = resolveTheme(preference)
}

export const setThemePreference = (preference: ThemePreference): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    /* localStorage indisponible */
  }
  applyTheme(preference)
}

// En mode auto, réagit aux changements du réglage système. À appeler une fois
// au démarrage ; renvoie une fonction de désinscription.
export const watchSystemTheme = (): (() => void) => {
  const query = darkQuery()
  if (!query) return () => undefined
  const handler = () => {
    if (getThemePreference() === 'auto') applyTheme('auto')
  }
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}
