import { lazy, Suspense } from 'react'
import { DevGate } from './DevGate.tsx'

const App = lazy(() => import('./App.tsx'))
const PortalApp = lazy(() => import('./portal/PortalApp.tsx'))

// La carte (App) s'ouvre uniquement pour le Studio (`?mode=studio`) ou la
// consultation d'une carte précise (`?m=<slug>`, ou `?code=<code>` legacy). Tout
// le reste — et surtout l'entrée du site `/` — affiche le portail.
const isStudioRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search)
  return params.get('mode') === 'studio' || window.location.hash === '#studio'
}

const hasMapId = (): boolean => {
  const params = new URLSearchParams(window.location.search)
  return params.has('m') || params.has('code')
}

const isMapRoute = (): boolean => isStudioRoute() || hasMapId()

// Consultation publique = un lien `?m=<slug>` (ou `?code=` legacy) ouvert hors
// Studio : la carte seule, en lecture seule. Ce cas contourne le mur d'accès dev
// (aucun risque, rien d'autre n'est exposé) ; le Studio, le portail et
// l'inscription restent derrière le DevGate.
const isPublicConsultation = (): boolean => hasMapId() && !isStudioRoute()

export function Root() {
  if (isPublicConsultation()) {
    return (
      <Suspense fallback={null}>
        <App />
      </Suspense>
    )
  }

  return (
    <DevGate>
      <Suspense fallback={null}>
        {isMapRoute() ? <App /> : <PortalApp />}
      </Suspense>
    </DevGate>
  )
}
