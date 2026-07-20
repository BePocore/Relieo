import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportHealthEvent } from './lib/health'

// Filet de sécurité racine (2026-07-20). L'app entière est en chunks lazy
// (App, PortalApp, MapLibreTrailMap, ConsultTutorial — cf. Root.tsx/App.tsx) :
// avant ce composant, une erreur de RENDU (pas un chunk manquant, ça c'est
// chunkReload.ts) faisait une page blanche silencieuse, sans message ni
// bouton. Seules les classes React peuvent attraper une erreur de rendu
// (`getDerivedStateFromError`/`componentDidCatch`) — pas de hook équivalent.
//
// Styles en inline (pas de dépendance à App.css, qui ne charge qu'avec le
// chunk App) : ce filet doit s'afficher même si l'erreur vient de PortalApp
// ou d'avant tout chargement de chunk. Les tokens `--c-*` viennent de
// index.css (chargé statiquement, thème déjà appliqué par main.tsx).

type Props = { children: ReactNode }
type State = { hasError: boolean }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportHealthEvent('render-error', {
      message: error.message,
      stack: error.stack ?? info.componentStack ?? undefined,
    })
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          background: 'var(--c-bg, #0f1623)',
          color: 'var(--c-text, #cdd7e1)',
          zIndex: 9999,
        }}
      >
        <div
          style={{
            display: 'grid',
            justifyItems: 'center',
            gap: 12,
            textAlign: 'center',
            padding: 24,
            maxWidth: 320,
          }}
        >
          <span style={{ fontSize: '1.05rem', fontWeight: 850 }}>Relieo</span>
          <span style={{ fontSize: '0.9rem', color: 'var(--c-text-dim, #8b97ab)' }}>
            Une erreur inattendue est survenue.
          </span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 6,
              padding: '9px 20px',
              borderRadius: 999,
              border: 'none',
              background: 'var(--c-accent, #2bc684)',
              color: 'var(--c-accent-ink, #06281a)',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Recharger
          </button>
        </div>
      </div>
    )
  }
}
