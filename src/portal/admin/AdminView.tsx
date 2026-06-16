import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Database,
  ExternalLink,
  EyeOff,
  HardDrive,
  Map as MapIcon,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react'
import { getIdToken } from '../firebase'
import { PLANS, formatBytes, type PlanId } from '../plans'
import './Admin.css'

type AdminUser = {
  uid: string
  email: string | null
  name?: string
  plan: string
  createdAt: string | null
  emailVerified: boolean
  hikeCount: number
  publishedCount: number
  mediaCount: number
  usedBytes: number
  monthlyCostEur: number
}

type AdminMap = {
  code: string
  folder: string
  ownerId: string
  ownerEmail: string | null
  title: string
  status: 'published' | 'draft'
  mediaCount: number
  pointCount: number
  updatedAt: string
}

type Overview = {
  userCount: number
  hikeCount: number
  publishedCount: number
  draftCount: number
  totalBytes: number
  freeBytes: number
  billableBytes: number
  monthlyCostEur: number
}

type AdminTab = 'users' | 'maps' | 'storage'

const formatEur = (value: number): string =>
  `${value.toLocaleString('fr-FR', {
    minimumFractionDigits: value > 0 && value < 1 ? 3 : 2,
    maximumFractionDigits: value > 0 && value < 1 ? 3 : 2,
  })} €`

const formatDate = (value: string | null): string =>
  value
    ? new Intl.DateTimeFormat('fr-FR', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(value))
    : '—'

const authFetch = async (
  input: string,
  init?: RequestInit,
): Promise<Response> => {
  const token = await getIdToken()
  if (!token) throw new Error('Connexion requise.')
  return fetch(input, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  })
}

export function AdminView() {
  const [tab, setTab] = useState<AdminTab>('users')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [maps, setMaps] = useState<AdminMap[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      // Premier await en tête : évite un setState synchrone dans l'effet de
      // montage (l'état `loading` est déjà à true par défaut).
      const token = await getIdToken()
      if (!token) throw new Error('Connexion requise.')
      setLoading(true)
      setError(null)
      const headers = { Authorization: `Bearer ${token}` }
      const [overviewRes, usersRes, mapsRes] = await Promise.all([
        fetch('/api/admin/overview', { cache: 'no-store', headers }),
        fetch('/api/admin/users', { cache: 'no-store', headers }),
        fetch('/api/admin/maps', { cache: 'no-store', headers }),
      ])
      if (!overviewRes.ok || !usersRes.ok || !mapsRes.ok) {
        const failed = [overviewRes, usersRes, mapsRes].find((r) => !r.ok)
        const data = (await failed?.json().catch(() => null)) as
          | { message?: string }
          | null
        throw new Error(data?.message ?? 'Lecture admin impossible.')
      }
      const overviewData = (await overviewRes.json()) as Overview
      const usersData = (await usersRes.json()) as { users: AdminUser[] }
      const mapsData = (await mapsRes.json()) as { maps: AdminMap[] }
      setOverview(overviewData)
      setUsers(usersData.users)
      setMaps(mapsData.maps)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Lecture admin impossible.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // load() est async : les setState surviennent après des await (pas de rendu
    // en cascade synchrone). Chargement au montage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  const changePlan = async (uid: string, plan: string) => {
    setBusyAction(`plan-${uid}`)
    try {
      const response = await authFetch('/api/admin/set-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, plan }),
      })
      if (!response.ok) throw new Error()
      setUsers((current) =>
        current.map((user) => (user.uid === uid ? { ...user, plan } : user)),
      )
    } catch {
      setError('Changement de forfait impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  const mapAction = async (
    code: string,
    action: 'unpublish' | 'delete',
  ) => {
    if (action === 'delete' && !window.confirm(`Supprimer définitivement la carte « ${code} » et ses médias ?`)) {
      return
    }
    setBusyAction(`map-${code}`)
    try {
      const response = await authFetch('/api/admin/map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, action }),
      })
      if (!response.ok) throw new Error()
      if (action === 'delete') {
        setMaps((current) => current.filter((map) => map.code !== code))
      } else {
        setMaps((current) =>
          current.map((map) =>
            map.code === code ? { ...map, status: 'draft' } : map,
          ),
        )
      }
    } catch {
      setError('Action sur la carte impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <section className="admin-view">
      <header className="page-heading">
        <div>
          <p className="portal-kicker">
            <ShieldCheck size={13} /> Administration
          </p>
          <h1>Console admin</h1>
          <p>Pilotage complet du site : utilisateurs, cartes et stockage.</p>
        </div>
        <button
          className="admin-refresh"
          disabled={loading}
          type="button"
          onClick={() => void load()}
        >
          <RefreshCw size={16} /> Actualiser
        </button>
      </header>

      <section className="admin-stats" aria-label="Synthèse">
        <article className="admin-stat-card featured">
          <span><Users size={18} /></span>
          <p>Utilisateurs</p>
          <strong>{overview?.userCount ?? '—'}</strong>
        </article>
        <article className="admin-stat-card">
          <span><MapIcon size={18} /></span>
          <p>Cartes</p>
          <strong>{overview?.hikeCount ?? '—'}</strong>
          <small>{overview?.publishedCount ?? 0} publiées · {overview?.draftCount ?? 0} brouillons</small>
        </article>
        <article className="admin-stat-card">
          <span><HardDrive size={18} /></span>
          <p>Stockage total</p>
          <strong>{overview ? formatBytes(overview.totalBytes) : '—'}</strong>
          <small>dont {overview ? formatBytes(overview.freeBytes) : '—'} gratuits</small>
        </article>
        <article className="admin-stat-card">
          <span><Database size={18} /></span>
          <p>Coût R2 / mois</p>
          <strong>{overview ? formatEur(overview.monthlyCostEur) : '—'}</strong>
          <small>facturé sur {overview ? formatBytes(overview.billableBytes) : '—'}</small>
        </article>
      </section>

      <nav className="admin-tabs" aria-label="Sections admin">
        <button className={tab === 'users' ? 'active' : ''} type="button" onClick={() => setTab('users')}><Users size={16} /> Utilisateurs</button>
        <button className={tab === 'maps' ? 'active' : ''} type="button" onClick={() => setTab('maps')}><MapIcon size={16} /> Cartes</button>
        <button className={tab === 'storage' ? 'active' : ''} type="button" onClick={() => setTab('storage')}><HardDrive size={16} /> Stockage R2</button>
      </nav>

      {error ? (
        <p className="admin-error"><AlertTriangle size={15} /> {error}</p>
      ) : null}

      {loading ? (
        <p className="admin-loading">Chargement des données…</p>
      ) : tab === 'users' ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Utilisateur</th>
                <th>Forfait</th>
                <th>Cartes</th>
                <th>Médias</th>
                <th>Stockage</th>
                <th>Coût R2/mois</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.uid}>
                  <td>
                    <div className="admin-user-cell">
                      <strong>{user.name || user.email || user.uid}</strong>
                      <small>{user.email ?? '—'}{user.emailVerified ? '' : ' · non vérifié'}</small>
                    </div>
                  </td>
                  <td>
                    <select
                      className="admin-plan-select"
                      disabled={busyAction === `plan-${user.uid}`}
                      value={user.plan}
                      onChange={(event) => void changePlan(user.uid, event.target.value as PlanId)}
                    >
                      {PLANS.map((plan) => (
                        <option key={plan.id} value={plan.id}>{plan.name}</option>
                      ))}
                    </select>
                  </td>
                  <td>{user.hikeCount} <small>({user.publishedCount} pub.)</small></td>
                  <td>{user.mediaCount}</td>
                  <td>{formatBytes(user.usedBytes)}</td>
                  <td>{formatEur(user.monthlyCostEur)}</td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr><td colSpan={6} className="admin-empty">Aucun utilisateur.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : tab === 'maps' ? (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Carte</th>
                <th>Propriétaire</th>
                <th>Statut</th>
                <th>Médias</th>
                <th>Modifiée</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {maps.map((map) => (
                <tr key={map.folder}>
                  <td>
                    <div className="admin-user-cell">
                      <strong>{map.title}</strong>
                      <small>{map.code}</small>
                    </div>
                  </td>
                  <td>{map.ownerEmail ?? map.ownerId}</td>
                  <td>
                    <span className={`admin-status ${map.status}`}>
                      {map.status === 'published' ? 'Publiée' : 'Brouillon'}
                    </span>
                  </td>
                  <td>{map.mediaCount}</td>
                  <td>{formatDate(map.updatedAt)}</td>
                  <td>
                    <div className="admin-actions">
                      <a
                        className="admin-action"
                        href={`/?mode=studio&code=${encodeURIComponent(map.code)}&title=${encodeURIComponent(map.title)}`}
                        title="Ouvrir dans le Studio (accès Dieu)"
                      >
                        <ExternalLink size={15} /> Ouvrir
                      </a>
                      {map.status === 'published' ? (
                        <button
                          className="admin-action"
                          disabled={busyAction === `map-${map.code}`}
                          type="button"
                          onClick={() => void mapAction(map.code, 'unpublish')}
                          title="Repasser en brouillon (retire du public)"
                        >
                          <EyeOff size={15} /> Dépublier
                        </button>
                      ) : null}
                      <button
                        className="admin-action danger"
                        disabled={busyAction === `map-${map.code}`}
                        type="button"
                        onClick={() => void mapAction(map.code, 'delete')}
                        title="Supprimer définitivement"
                      >
                        <Trash2 size={15} /> Supprimer
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {maps.length === 0 ? (
                <tr><td colSpan={6} className="admin-empty">Aucune carte.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="admin-storage">
          <article className="admin-storage-card">
            <h2>Cloudflare R2</h2>
            <dl>
              <div><dt>Stockage total</dt><dd>{overview ? formatBytes(overview.totalBytes) : '—'}</dd></div>
              <div><dt>Palier gratuit</dt><dd>{overview ? formatBytes(overview.freeBytes) : '—'}</dd></div>
              <div><dt>Volume facturé</dt><dd>{overview ? formatBytes(overview.billableBytes) : '—'}</dd></div>
              <div><dt>Coût mensuel réel</dt><dd className="admin-cost">{overview ? formatEur(overview.monthlyCostEur) : '—'}</dd></div>
            </dl>
            <p className="admin-note">
              R2 facture le stockage à l'usage : les 10 premiers Go par mois sont
              gratuits, puis ~0,015 €/Go/mois (sortie de données gratuite).
            </p>
          </article>
          <article className="admin-storage-card">
            <h2>Top consommateurs</h2>
            <ul className="admin-top-users">
              {users.slice(0, 8).map((user) => (
                <li key={user.uid}>
                  <span>{user.name || user.email || user.uid}</span>
                  <strong>{formatBytes(user.usedBytes)}</strong>
                  <small>{formatEur(user.monthlyCostEur)}/mois</small>
                </li>
              ))}
              {users.length === 0 ? <li className="admin-empty">Aucun utilisateur.</li> : null}
            </ul>
          </article>
        </div>
      )}
    </section>
  )
}
