// Récupération automatique après un déploiement. Quand un onglet garde une
// ancienne version de l'app, ses imports dynamiques (chunks de code hashés)
// n'existent plus sur le serveur : l'import échoue et l'app reste bloquée sur
// le voile « Chargement de la carte… », sans message ni issue. Vite émet alors
// l'événement `vite:preloadError` ; on recharge la page UNE fois pour récupérer
// la version courante des fichiers.
//
// Garde anti-boucle : on mémorise l'instant du dernier rechargement forcé
// (sessionStorage) et on ne recharge pas deux fois en moins de 15 s. Un échec
// persistant (réseau coupé, serveur en panne) ne doit pas faire boucler l'onglet
// à l'infini — au bout d'un rechargement, on laisse la main au chien de garde du
// voile (bouton « Recharger » dans App.tsx).

const GUARD_KEY = 'relieo.chunk-reload'
const MIN_INTERVAL_MS = 15_000

export function installChunkReload(): void {
  window.addEventListener('vite:preloadError', (event) => {
    // Sans preventDefault, l'échec de préchargement remonte en erreur non gérée.
    event.preventDefault()
    const now = Date.now()
    let last = 0
    try {
      last = Number(sessionStorage.getItem(GUARD_KEY)) || 0
    } catch {
      // Stockage indisponible (navigation privée stricte) : on tentera au plus
      // un rechargement, ce qui reste préférable à un voile figé.
    }
    if (now - last < MIN_INTERVAL_MS) return
    try {
      sessionStorage.setItem(GUARD_KEY, String(now))
    } catch {
      // ignore
    }
    window.location.reload()
  })
}
