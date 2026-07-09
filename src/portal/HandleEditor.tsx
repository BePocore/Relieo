import { useEffect, useRef, useState } from 'react'
import { AtSign, Check } from 'lucide-react'
import { checkHandle, fetchContext, saveHandle } from './socialApi'

// Éditeur de pseudo unique (@handle), partagé par l'écran « Votre profil » du
// dashboard créateur ET l'écran de compte du viewer : un seul profil partout.
// Autonome : il récupère lui-même le pseudo courant + une suggestion via
// `/api/social` (context), vérifie la disponibilité en direct et enregistre.

type Status =
  | 'idle'
  | 'checking'
  | 'available'
  | 'taken'
  | 'invalid'
  | 'saved'
  | 'error'

const HINT: Record<Status, string> = {
  idle: '3 à 20 caractères : lettres, chiffres, « _ ». Il identifie ton profil public.',
  checking: 'Vérification…',
  available: '✓ Disponible.',
  taken: 'Déjà pris, essaie autre chose.',
  invalid: 'Format invalide (a-z, 0-9, _).',
  saved: '✓ Pseudo enregistré.',
  error: 'Erreur réseau, réessaie.',
}

const HINT_COLOR: Partial<Record<Status, string>> = {
  available: '#3fae6f',
  saved: '#3fae6f',
  taken: '#d95a5a',
  invalid: '#d95a5a',
  error: '#d95a5a',
}

export function HandleEditor() {
  const [loaded, setLoaded] = useState(false)
  const [current, setCurrent] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [saving, setSaving] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let alive = true
    fetchContext()
      .then((ctx) => {
        if (!alive) return
        setCurrent(ctx.handle)
        setValue(ctx.handle ?? ctx.suggestedHandle)
        setLoaded(true)
      })
      .catch(() => alive && setLoaded(true))
    return () => {
      alive = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const normalized = value.trim().replace(/^@+/, '').toLowerCase()
  const unchanged = normalized === (current ?? '')

  const onChange = (next: string) => {
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    const candidate = next.trim().replace(/^@+/, '').toLowerCase()
    if (!candidate || candidate === (current ?? '')) {
      setStatus('idle')
      return
    }
    setStatus('checking')
    timer.current = setTimeout(() => {
      checkHandle(candidate)
        .then((result) => {
          if (result.reason === 'invalid') setStatus('invalid')
          else if (result.available) setStatus('available')
          else setStatus('taken')
        })
        .catch(() => setStatus('error'))
    }, 400)
  }

  const onSave = () => {
    if (saving || unchanged || !normalized) return
    setSaving(true)
    saveHandle(normalized)
      .then((result) => {
        if (result.ok && result.handle) {
          setStatus('saved')
          setCurrent(result.handle)
        } else if (result.reason === 'taken') setStatus('taken')
        else setStatus('invalid')
      })
      .catch(() => setStatus('error'))
      .finally(() => setSaving(false))
  }

  if (!loaded) return null

  return (
    <div className="profile-password">
      <div className="profile-password-text">
        <h3>Ton pseudo</h3>
        <p>
          {current
            ? `Ton profil public est @${current}.`
            : 'Choisis un pseudo unique pour ton profil public.'}
        </p>
      </div>
      <div className="profile-password-form">
        <label>
          <span>Pseudo public</span>
          <div className="input-shell">
            <AtSign size={17} />
            <input
              type="text"
              value={value}
              placeholder="pseudo"
              spellCheck={false}
              autoCapitalize="none"
              maxLength={20}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
          <small style={{ color: HINT_COLOR[status] }}>{HINT[status]}</small>
        </label>
        <button
          className="portal-primary"
          type="button"
          disabled={saving || unchanged || !normalized || status === 'taken'}
          onClick={onSave}
        >
          {status === 'saved' ? <Check size={17} /> : <AtSign size={17} />}
          {saving ? 'Enregistrement…' : 'Enregistrer le pseudo'}
        </button>
      </div>
    </div>
  )
}
