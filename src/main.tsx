import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Root } from './Root.tsx'
import { applyTheme, watchSystemTheme } from './lib/theme'

// Applique le thème (clair/nuit/auto) avant le rendu pour éviter tout flash,
// puis suit le réglage système quand la préférence est « auto ».
applyTheme()
watchSystemTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
