import { Compass } from 'lucide-react'

// Écran plein écran affiché à un visiteur quand une carte est introuvable ou
// n'est pas en ligne. Le message reste neutre (il ne révèle pas l'existence
// d'un brouillon) et réutilise le style de l'écran d'accès (AccessGate).
export function UnavailableMap() {
  return (
    <div className="access-gate" role="dialog" aria-label="Carte indisponible">
      <div className="access-card">
        <span className="access-icon">
          <Compass aria-hidden="true" size={26} />
        </span>
        <h2>Relieo</h2>
        <p>
          Cette carte n’est pas disponible. Le lien est peut-être erroné, ou la
          carte n’est pas en ligne.
        </p>
        <button
          className="primary-action"
          type="button"
          onClick={() => window.location.assign('/')}
        >
          Retour à l’accueil
        </button>
      </div>
    </div>
  )
}
