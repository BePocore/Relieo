import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CreditCard,
  Database,
  Euro,
  ExternalLink,
  EyeOff,
  HardDrive,
  LayoutDashboard,
  LineChart,
  LogOut,
  Map as MapIcon,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TrendingUp,
  Users,
} from 'lucide-react'
import type { PortalUser } from '../portalStore'
import { getIdToken } from '../firebase'
import { PLANS, formatBytes, type PlanId } from '../plans'
import { UserGrowthChart, type ChartSeries } from './UserGrowthChart'
import './Admin.css'

type AdminUser = {
  uid: string
  email: string | null
  name?: string
  plan: string
  isAdmin: boolean
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

type AdminSection = 'overview' | 'users' | 'maps' | 'storage'

const SECTION_TITLES: Record<AdminSection, string> = {
  overview: 'Vue d’ensemble',
  users: 'Utilisateurs',
  maps: 'Cartes',
  storage: 'Stockage R2',
}

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

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'A'

const authFetch = async (
  input: string,
  init?: RequestInit,
): Promise<Response> => {
  const token = await getIdToken()
  if (!token) throw new Error('Connexion requise.')
  return fetch(input, {
    ...init,
    cache: 'no-store',
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  })
}

export function AdminApp({
  user,
  onLogout,
}: {
  user: PortalUser
  onLogout: () => void
}) {
  const [section, setSection] = useState<AdminSection>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [maps, setMaps] = useState<AdminMap[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  // Fenêtre temporelle du graphe d'évolution (en mois, 'all' = tout l'historique).
  const [rangeMonths, setRangeMonths] = useState<number | 'all'>('all')

  const load = useCallback(async () => {
    try {
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
      setOverview((await overviewRes.json()) as Overview)
      setUsers(((await usersRes.json()) as { users: AdminUser[] }).users)
      setMaps(((await mapsRes.json()) as { maps: AdminMap[] }).maps)
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
    // load() est async : setState après await (pas de rendu en cascade).
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
        current.map((u) => (u.uid === uid ? { ...u, plan } : u)),
      )
    } catch {
      setError('Changement de forfait impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  const mapAction = async (code: string, action: 'unpublish' | 'delete') => {
    if (
      action === 'delete' &&
      !window.confirm(`Supprimer définitivement la carte « ${code} » et ses médias ?`)
    ) {
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
        setMaps((current) => current.filter((m) => m.code !== code))
      } else {
        setMaps((current) =>
          current.map((m) => (m.code === code ? { ...m, status: 'draft' } : m)),
        )
      }
    } catch {
      setError('Action sur la carte impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  // Revenus + évolution des inscriptions, dérivés de la liste des utilisateurs
  // (l'admin est exclu, il ne paie pas et ne compte pas comme client).
  const analytics = useMemo(() => {
    const clients = users.filter((u) => !u.isAdmin)
    const priceOf = (planId: string) =>
      PLANS.find((p) => p.id === planId)?.monthlyPriceEur ?? 0

    const mrr = clients.reduce((sum, u) => sum + priceOf(u.plan), 0)
    const paidCount = clients.filter((u) => priceOf(u.plan) > 0).length
    const arpu = clients.length ? mrr / clients.length : 0
    const perPlan = PLANS.map((plan) => {
      const count = clients.filter((u) => u.plan === plan.id).length
      return { plan, count, monthly: count * plan.monthlyPriceEur }
    })

    // Évolution cumulée par mois. On part d'un mois de référence à 0 avant la
    // première inscription pour toujours avoir une courbe qui démarre du bas.
    const dated = clients
      .map((u) => ({ t: u.createdAt ? new Date(u.createdAt).getTime() : NaN, plan: u.plan }))
      .filter((u) => Number.isFinite(u.t))
      .sort((a, b) => a.t - b.t)

    let chart: { labels: string[]; series: ChartSeries[] } | null = null
    if (dated.length > 0) {
      const first = new Date(dated[0].t)
      const now = new Date()
      const allMonths: Array<{ label: string; end: number }> = []
      // Mois de référence (un mois avant la première inscription) à 0.
      const cursor = new Date(first.getFullYear(), first.getMonth() - 1, 1)
      const lastMonth = new Date(now.getFullYear(), now.getMonth(), 1)
      while (cursor <= lastMonth) {
        const end = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59).getTime()
        allMonths.push({
          label: cursor.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }),
          end,
        })
        cursor.setMonth(cursor.getMonth() + 1)
      }
      // Fenêtre sélectionnée (le cumul reste compté depuis le début).
      const months = rangeMonths === 'all' ? allMonths : allMonths.slice(-rangeMonths)
      const cumulative = (end: number, planId?: string) =>
        dated.filter((u) => u.t <= end && (!planId || u.plan === planId)).length

      const series: ChartSeries[] = [
        { id: 'total', label: 'Total', color: '#2f6df0', values: months.map((m) => cumulative(m.end)) },
        ...PLANS.map((plan, i) => ({
          id: plan.id,
          label: plan.name,
          color: ['#1aa06a', '#f4a23b', '#8b5cf6'][i] ?? '#94a3b8',
          values: months.map((m) => cumulative(m.end, plan.id)),
        })),
      ]
      chart = { labels: months.map((m) => m.label), series }
    }

    return { mrr, paidCount, arpu, perPlan, chart, clientCount: clients.length }
  }, [users, rangeMonths])

  const navItems: Array<{ id: AdminSection; label: string; icon: ReactNode }> = [
    { id: 'overview', label: 'Vue d’ensemble', icon: <LayoutDashboard size={18} /> },
    { id: 'users', label: 'Utilisateurs', icon: <Users size={18} /> },
    { id: 'maps', label: 'Cartes', icon: <MapIcon size={18} /> },
    { id: 'storage', label: 'Stockage R2', icon: <HardDrive size={18} /> },
  ]

  const statCards = (
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
  )

  const usersTable = (
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
          {users.map((u) =>
            u.isAdmin ? (
              <tr className="admin-row" key={u.uid}>
                <td colSpan={6}>
                  <div className="admin-user-cell">
                    <strong>
                      {u.name || u.email || u.uid}
                      <span className="admin-row-badge">
                        <ShieldCheck size={12} /> Admin
                      </span>
                    </strong>
                    <small>{u.email ?? '—'} · Compte administrateur, non comptabilisé</small>
                  </div>
                </td>
              </tr>
            ) : (
              <tr key={u.uid}>
                <td>
                  <div className="admin-user-cell">
                    <strong>{u.name || u.email || u.uid}</strong>
                    <small>{u.email ?? '—'}{u.emailVerified ? '' : ' · non vérifié'}</small>
                  </div>
                </td>
                <td>
                  <select
                    className="admin-plan-select"
                    disabled={busyAction === `plan-${u.uid}`}
                    value={u.plan}
                    onChange={(event) => void changePlan(u.uid, event.target.value as PlanId)}
                  >
                    {PLANS.map((plan) => (
                      <option key={plan.id} value={plan.id}>{plan.name}</option>
                    ))}
                  </select>
                </td>
                <td>{u.hikeCount} <small>({u.publishedCount} pub.)</small></td>
                <td>{u.mediaCount}</td>
                <td>{formatBytes(u.usedBytes)}</td>
                <td>{formatEur(u.monthlyCostEur)}</td>
              </tr>
            ),
          )}
          {users.length === 0 ? (
            <tr><td className="admin-empty" colSpan={6}>Aucun utilisateur.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )

  const mapsTable = (
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
          {maps.map((m) => (
            <tr key={m.folder}>
              <td>
                <div className="admin-user-cell">
                  <strong>{m.title}</strong>
                  <small>{m.code}</small>
                </div>
              </td>
              <td>{m.ownerEmail ?? m.ownerId}</td>
              <td><span className={`admin-status ${m.status}`}>{m.status === 'published' ? 'Publiée' : 'Brouillon'}</span></td>
              <td>{m.mediaCount}</td>
              <td>{formatDate(m.updatedAt)}</td>
              <td>
                <div className="admin-actions">
                  <a
                    className="admin-action"
                    href={`/?mode=studio&code=${encodeURIComponent(m.code)}&title=${encodeURIComponent(m.title)}`}
                    title="Ouvrir dans le Studio (accès Dieu)"
                  >
                    <ExternalLink size={15} /> Ouvrir
                  </a>
                  {m.status === 'published' ? (
                    <button
                      className="admin-action"
                      disabled={busyAction === `map-${m.code}`}
                      type="button"
                      onClick={() => void mapAction(m.code, 'unpublish')}
                      title="Repasser en brouillon"
                    >
                      <EyeOff size={15} /> Dépublier
                    </button>
                  ) : null}
                  <button
                    className="admin-action danger"
                    disabled={busyAction === `map-${m.code}`}
                    type="button"
                    onClick={() => void mapAction(m.code, 'delete')}
                    title="Supprimer définitivement"
                  >
                    <Trash2 size={15} /> Supprimer
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {maps.length === 0 ? (
            <tr><td className="admin-empty" colSpan={6}>Aucune carte.</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )

  const storagePanels = (
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
          {users.filter((u) => !u.isAdmin).slice(0, 8).map((u) => (
            <li key={u.uid}>
              <span>{u.name || u.email || u.uid}</span>
              <strong>{formatBytes(u.usedBytes)}</strong>
              <small>{formatEur(u.monthlyCostEur)}/mois</small>
            </li>
          ))}
          {users.filter((u) => !u.isAdmin).length === 0 ? (
            <li className="admin-empty">Aucun utilisateur.</li>
          ) : null}
        </ul>
      </article>
    </div>
  )

  const revenuePanel = (
    <section className="admin-panel" aria-label="Revenus">
      <header className="admin-panel-head">
        <h2><Euro size={18} /> Revenus</h2>
        <p>Revenu mensuel récurrent généré par les forfaits payants.</p>
      </header>
      <div className="admin-revenue-cards">
        <article className="admin-mini-card featured">
          <span><Euro size={16} /></span>
          <p>Revenu mensuel (MRR)</p>
          <strong>{formatEur(analytics.mrr)}</strong>
        </article>
        <article className="admin-mini-card">
          <span><TrendingUp size={16} /></span>
          <p>Projection annuelle</p>
          <strong>{formatEur(analytics.mrr * 12)}</strong>
        </article>
        <article className="admin-mini-card">
          <span><CreditCard size={16} /></span>
          <p>Abonnés payants</p>
          <strong>{analytics.paidCount}</strong>
          <small>sur {analytics.clientCount} utilisateurs</small>
        </article>
        <article className="admin-mini-card">
          <span><Users size={16} /></span>
          <p>Revenu moyen / utilisateur</p>
          <strong>{formatEur(analytics.arpu)}</strong>
        </article>
      </div>
      <table className="admin-table admin-revenue-table">
        <thead>
          <tr><th>Forfait</th><th>Prix</th><th>Abonnés</th><th>Revenu / mois</th></tr>
        </thead>
        <tbody>
          {analytics.perPlan.map(({ plan, count, monthly }) => (
            <tr key={plan.id}>
              <td>
                <strong>{plan.name}</strong>
                {plan.available ? null : <small> · à venir</small>}
              </td>
              <td>{plan.monthlyPriceEur === 0 ? 'Gratuit' : `${formatEur(plan.monthlyPriceEur)}/mois`}</td>
              <td>{count}</td>
              <td>{formatEur(monthly)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )

  const growthPanel = (
    <section className="admin-panel" aria-label="Évolution des utilisateurs">
      <header className="admin-panel-head admin-panel-head-row">
        <div>
          <h2><LineChart size={18} /> Évolution des utilisateurs</h2>
          <p>Inscriptions cumulées par forfait, mois par mois.</p>
        </div>
        <select
          className="admin-range-select"
          value={rangeMonths === 'all' ? 'all' : String(rangeMonths)}
          onChange={(event) =>
            setRangeMonths(event.target.value === 'all' ? 'all' : Number(event.target.value))
          }
        >
          <option value="3">3 derniers mois</option>
          <option value="6">6 derniers mois</option>
          <option value="12">12 derniers mois</option>
          <option value="all">Tout l’historique</option>
        </select>
      </header>
      {analytics.chart ? (
        <>
          <div className="admin-chart-legend">
            {analytics.chart.series.map((s) => (
              <span key={s.id}><i style={{ background: s.color }} />{s.label}</span>
            ))}
          </div>
          <UserGrowthChart labels={analytics.chart.labels} series={analytics.chart.series} />
        </>
      ) : (
        <p className="admin-empty">Pas encore d’inscription à afficher.</p>
      )}
    </section>
  )

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand">
          <span className="admin-logo"><ShieldCheck size={20} /></span>
          <div>
            <strong>Relieo</strong>
            <span className="admin-badge">Admin</span>
          </div>
        </div>
        <nav aria-label="Navigation admin">
          <p>GESTION</p>
          {navItems.map((item) => (
            <button
              className={section === item.id ? 'active' : ''}
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </nav>
        <button className="admin-logout" type="button" onClick={onLogout}>
          <LogOut size={18} /> Déconnexion
        </button>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div>
            <p className="admin-kicker"><ShieldCheck size={13} /> Console d’administration</p>
            <h1>{SECTION_TITLES[section]}</h1>
          </div>
          <div className="admin-topbar-right">
            <button className="admin-refresh" disabled={loading} type="button" onClick={() => void load()}>
              <RefreshCw size={16} /> Actualiser
            </button>
            <div className="admin-identity">
              <span className="admin-avatar">{initials(user.name)}</span>
              <span><strong>{user.name}</strong><small>{user.email}</small></span>
            </div>
          </div>
        </header>

        <div className="admin-content">
          {error ? (
            <p className="admin-error"><AlertTriangle size={15} /> {error}</p>
          ) : null}

          {loading ? (
            <p className="admin-loading">Chargement des données…</p>
          ) : section === 'overview' ? (
            <>
              {statCards}
              {storagePanels}
              {revenuePanel}
              {growthPanel}
            </>
          ) : section === 'users' ? (
            usersTable
          ) : section === 'maps' ? (
            mapsTable
          ) : (
            storagePanels
          )}
        </div>
      </main>
    </div>
  )
}
