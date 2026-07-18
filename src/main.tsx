import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Root } from './Root.tsx'
import { installChunkReload } from './lib/chunkReload'
import { applyTheme, watchSystemTheme } from './lib/theme'

// Récupère automatiquement l'app quand un onglet garde une version périmée après
// un déploiement (chunk de code introuvable → voile figé). À installer avant
// tout import dynamique.
installChunkReload()

// Applique le thème (clair/nuit/auto) avant le rendu pour éviter tout flash,
// puis suit le réglage système quand la préférence est « auto ».
applyTheme()
watchSystemTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
