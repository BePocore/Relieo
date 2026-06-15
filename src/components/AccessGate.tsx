import { useState } from 'react'
import type { FormEvent } from 'react'
import { Compass, LockKeyhole } from 'lucide-react'

type AccessGateProps = {
  onSubmit: (code: string) => boolean
}

export function AccessGate({ onSubmit }: AccessGateProps) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const granted = onSubmit(code)
    if (!granted) setError(true)
  }

  return (
    <div className="access-gate" role="dialog" aria-modal="true" aria-label="Accès protégé">
      <form className="access-card" onSubmit={handleSubmit}>
        <span className="access-icon">
          <Compass aria-hidden="true" size={26} />
        </span>
        <h2>Relieo</h2>
        <p>Cette carte est protégée. Saisis le code d’accès pour la consulter.</p>

        <label className="access-field">
          <LockKeyhole aria-hidden="true" size={16} />
          <input
            autoFocus
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder="Code d’accès"
            value={code}
            onChange={(event) => {
              setCode(event.target.value)
              setError(false)
            }}
          />
        </label>

        {error ? <p className="access-error">Code incorrect.</p> : null}

        <button className="primary-action" type="submit" disabled={!code.trim()}>
          Entrer
        </button>
      </form>
    </div>
  )
}
