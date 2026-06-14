import { lazy, Suspense } from 'react'

const App = lazy(() => import('./App.tsx'))
const PortalApp = lazy(() => import('./portal/PortalApp.tsx'))

// La carte (App) s'ouvre uniquement pour le Studio (`?mode=studio`) ou la
// consultation d'une rando précise (`?code=<code>`). Tout le reste — et surtout
// l'entrée du site `/` — affiche le portail (login → dashboard).
const isMapRoute = (): boolean => {
  const params = new URLSearchParams(window.location.search)
  return (
    params.get('mode') === 'studio' ||
    params.has('code') ||
    window.location.hash === '#studio'
  )
}

export function Root() {
  return (
    <Suspense fallback={null}>{isMapRoute() ? <App /> : <PortalApp />}</Suspense>
  )
}
