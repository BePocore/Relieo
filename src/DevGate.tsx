import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

// Mur d'accès temporaire « site en développement ». Tant que le visiteur n'a pas
// saisi le bon mot de passe (vérifié côté serveur via /api/gate), rien du site
// n'est affiché : ni portail, ni inscription, ni carte. À retirer au lancement
// public (supprimer ce composant, son usage dans Root.tsx, l'endpoint api/gate.ts
// et la variable d'env SITE_GATE_PASSWORD).

type Status = 'checking' | 'locked' | 'unlocked'

const isLocalhost = (): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

export function DevGate({ children }: { children: ReactNode }) {
  // En local on ne bloque pas (confort de dev) ; partout ailleurs on vérifie.
  const [status, setStatus] = useState<Status>(
    isLocalhost() ? 'unlocked' : 'checking',
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (status !== 'checking') return
    let cancelled = false
    fetch('/api/gate')
      .then((response) => response.json())
      .then((data: { ok?: boolean }) => {
        if (!cancelled) setStatus(data?.ok ? 'unlocked' : 'locked')
      })
      .catch(() => {
        // En cas d'erreur réseau, on reste fermé (fail-closed).
        if (!cancelled) setStatus('locked')
      })
    return () => {
      cancelled = true
    }
  }, [status])

  if (status === 'unlocked') return <>{children}</>

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(false)
    try {
      const response = await fetch('/api/gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = (await response.json()) as { ok?: boolean }
      if (data?.ok) {
        setStatus('unlocked')
        return
      }
      setError(true)
    } catch {
      setError(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div style={styles.screen}>
      <div style={styles.card}>
        <p style={styles.kicker}>Relieo</p>
        <h1 style={styles.title}>Site en développement</h1>
        <p style={styles.subtitle}>
          L'accès est réservé pour le moment. Saisis le mot de passe d'accès pour
          continuer.
        </p>
        {status === 'checking' ? (
          <p style={styles.subtitle}>Chargement…</p>
        ) : (
          <form onSubmit={submit} style={styles.form}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Mot de passe d'accès"
              autoFocus
              style={styles.input}
            />
            {error && (
              <p style={styles.error}>Mot de passe incorrect.</p>
            )}
            <button
              type="submit"
              disabled={submitting || password.length === 0}
              style={{
                ...styles.button,
                opacity: submitting || password.length === 0 ? 0.6 : 1,
              }}
            >
              {submitting ? 'Vérification…' : 'Entrer'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  screen: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: '#0f1623',
    color: '#cdd7e1',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: '380px',
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '16px',
    padding: '32px 28px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
    textAlign: 'center',
  },
  kicker: {
    margin: 0,
    fontSize: '13px',
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: '#5eb0ef',
    fontWeight: 600,
  },
  title: {
    margin: '12px 0 8px',
    fontSize: '22px',
    color: '#f3f6fa',
    fontWeight: 700,
  },
  subtitle: {
    margin: '0 0 20px',
    fontSize: '14px',
    lineHeight: 1.5,
    color: '#9fb0c3',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '12px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    background: 'rgba(0, 0, 0, 0.25)',
    color: '#f3f6fa',
    fontSize: '15px',
    outline: 'none',
  },
  error: {
    margin: 0,
    fontSize: '13px',
    color: '#f08a8a',
  },
  button: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: '10px',
    border: 'none',
    background: '#2f6df0',
    color: '#fff',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
  },
}
