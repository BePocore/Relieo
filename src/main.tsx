import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Root } from './Root.tsx'
import { AppErrorBoundary } from './ErrorBoundary.tsx'
import { installChunkReload } from './lib/chunkReload'
import { installHealthMonitoring } from './lib/health'
import { applyTheme, watchSystemTheme } from './lib/theme'

// Récupère automatiquement l'app quand un onglet garde une version périmée après
// un déploiement (chunk de code introuvable → voile figé). À installer avant
// tout import dynamique.
installChunkReload()

// Monitoring santé (erreurs JS globales) : voir server/health.ts pour le
// pourquoi. À installer tôt, avant le rendu.
installHealthMonitoring()

// Applique le thème (clair/nuit/auto) avant le rendu pour éviter tout flash,
// puis suit le réglage système quand la préférence est « auto ».
applyTheme()
watchSystemTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <Root />
    </AppErrorBoundary>
  </StrictMode>,
)
