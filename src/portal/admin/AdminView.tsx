import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Ban,
  Bell,
  CreditCard,
  Database,
  Euro,
  ExternalLink,
  EyeOff,
  Gavel,
  HardDrive,
  LayoutDashboard,
  LineChart,
  LogOut,
  Map as MapIcon,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
  TrendingUp,
  Unlock,
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
  status: 'active' | 'blocked' | 'deleted'
  banCount: number
  // Demande de suppression volontaire en attente.
  deletionRequest: boolean
  // Trace d'un compte supprimé (date + admin).
  deletedAt: string | null
  deletedBy: string | null
}

type AdminNotification = {
  id: string
  type: 'appeal' | 'deletion-request'
  fromUid: string
  fromEmail: string | null
  message: string
  createdAt: string
  read: boolean
  // Réponse de l'admin à CET appel (par notification).
  reply: { message: string; sentAt: string } | null
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

type Sanction = {
  id: string
  action: 'unpublish' | 'delete' | 'block' | 'unblock' | 'delete-account'
  mapCode: string
  mapTitle: string
  ownerId: string
  ownerEmail: string | null
  targetUid?: string
  targetEmail?: string | null
  adminUid: string
  adminEmail: string | null
  message: string
  createdAt: string
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

type AdminSection =
  | 'overview'
  | 'users'
  | 'maps'
  | 'sanctions'
  | 'notifications'
  | 'storage'

const SECTION_TITLES: Record<AdminSection, string> = {
  overview: 'Vue d’ensemble',
  users: 'Utilisateurs',
  maps: 'Cartes',
  sanctions: 'Sanctions',
  notifications: 'Notifications',
  storage: 'Stockage R2',
}

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

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
  const [sanctions, setSanctions] = useState<Sanction[]>([])
  const [notifications, setNotifications] = useState<AdminNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  // Fenêtre temporelle du graphe d'évolution (en mois, 'all' = tout l'historique).
  const [rangeMonths, setRangeMonths] = useState<number | 'all'>('all')
  // Modale de dépublication : carte ciblée + message à transmettre au propriétaire.
  const [unpublishTarget, setUnpublishTarget] = useState<AdminMap | null>(null)
  const [unpublishMessage, setUnpublishMessage] = useState('')
  // Modale de suppression : carte ciblée + saisie de confirmation (« delete »)
  // + message facultatif transmis au propriétaire.
  const [deleteTarget, setDeleteTarget] = useState<AdminMap | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteMessage, setDeleteMessage] = useState('')
  // Modale de blocage d'un compte : utilisateur ciblé + message obligatoire.
  const [blockTarget, setBlockTarget] = useState<AdminUser | null>(null)
  const [blockMessage, setBlockMessage] = useState('')
  // Modale de suppression d'un compte : utilisateur + confirmation + message.
  const [deleteUserTarget, setDeleteUserTarget] = useState<AdminUser | null>(null)
  const [deleteUserConfirm, setDeleteUserConfirm] = useState('')
  const [deleteUserMessage, setDeleteUserMessage] = useState('')
  // Notification de demande liée à la suppression en cours (pour la marquer lue).
  const [deleteUserNotifId, setDeleteUserNotifId] = useState<string | null>(null)
  // Modale de réponse à un appel de banni.
  const [replyTarget, setReplyTarget] = useState<AdminNotification | null>(null)
  const [replyMessage, setReplyMessage] = useState('')

  const load = useCallback(async () => {
    try {
      const token = await getIdToken()
      if (!token) throw new Error('Connexion requise.')
      setLoading(true)
      setError(null)
      const headers = { Authorization: `Bearer ${token}` }
      // Une seule lecture regroupée (cf. api/admin/dashboard).
      const response = await fetch('/api/admin/dashboard', {
        cache: 'no-store',
        headers,
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { message?: string }
          | null
        throw new Error(data?.message ?? 'Lecture admin impossible.')
      }
      const data = (await response.json()) as {
        overview: Overview
        users: AdminUser[]
        maps: AdminMap[]
        sanctions: Sanction[]
        notifications: AdminNotification[]
      }
      setOverview(data.overview)
      setUsers(data.users)
      setMaps(data.maps)
      setSanctions(data.sanctions)
      setNotifications(data.notifications)
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
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-plan', uid, plan }),
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

  const mapAction = async (
    code: string,
    action: 'unpublish' | 'delete',
    extra?: { message?: string; title?: string },
  ) => {
    setBusyAction(`map-${code}`)
    try {
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'map', op: action, code, ...extra }),
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

  const userAction = async (
    uid: string,
    action: 'block' | 'unblock' | 'delete-account' | 'dismiss-deletion-request',
    message?: string,
    notifId?: string,
  ) => {
    setBusyAction(`user-${uid}`)
    try {
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'user-action', op: action, uid, message, notifId }),
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { message?: string }
          | null
        throw new Error(data?.message ?? 'Action impossible.')
      }
      // Recharge tout (statut, banCount, journal, notifications) pour rester sûr.
      await load()
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : 'Action sur le compte impossible.',
      )
    } finally {
      setBusyAction(null)
    }
  }

  const replyToAppeal = async (notif: AdminNotification, message: string) => {
    setBusyAction(`reply-${notif.id}`)
    try {
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply-appeal',
          uid: notif.fromUid,
          message,
          notifId: notif.id,
        }),
      })
      if (!response.ok) throw new Error()
      await load()
    } catch {
      setError('Envoi de la réponse impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  const markNotificationsRead = async (ids: string[]) => {
    if (ids.length === 0) return
    setNotifications((current) =>
      current.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)),
    )
    try {
      await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark-read', ids }),
      })
    } catch {
      setError('Mise à jour des notifications impossible.')
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

  const unreadCount = notifications.filter((n) => !n.read).length

  const navItems: Array<{ id: AdminSection; label: string; icon: ReactNode; badge?: number }> = [
    { id: 'overview', label: 'Vue d’ensemble', icon: <LayoutDashboard size={18} /> },
    { id: 'users', label: 'Utilisateurs', icon: <Users size={18} /> },
    { id: 'maps', label: 'Cartes', icon: <MapIcon size={18} /> },
    { id: 'sanctions', label: 'Sanctions', icon: <Gavel size={18} /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell size={18} />, badge: unreadCount },
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
            <th>Supprimé</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) =>
            u.isAdmin ? (
              <tr className="admin-row" key={u.uid}>
                <td colSpan={8}>
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
              <tr className={u.deletionRequest ? 'admin-row-danger' : undefined} key={u.uid}>
                <td>
                  <div className="admin-user-cell">
                    <strong>
                      {u.name || u.email || u.uid}
                      {u.status === 'blocked' ? (
                        <span className="admin-status-badge blocked"><Ban size={11} /> Bloqué</span>
                      ) : u.status === 'deleted' ? (
                        <span className="admin-status-badge deleted"><Trash2 size={11} /> Supprimé</span>
                      ) : null}
                    </strong>
                    <small>
                      {u.email ?? '—'}{u.emailVerified ? '' : ' · non vérifié'}
                      {u.banCount > 0 ? ` · ${u.banCount} ban${u.banCount > 1 ? 's' : ''}` : ''}
                    </small>
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
                <td>
                  {u.status === 'deleted' ? (
                    <span className="admin-deleted-cell">
                      Oui{u.deletedAt ? ` — ${formatDate(u.deletedAt)}` : ''}
                      {u.deletedBy ? <small>par {u.deletedBy}</small> : null}
                    </span>
                  ) : u.deletionRequest ? (
                    <span className="admin-deleted-cell pending">Demande en cours</span>
                  ) : (
                    'Non'
                  )}
                </td>
                <td>
                  {u.status === 'deleted' ? (
                    <span className="admin-muted-text">—</span>
                  ) : (
                    <div className="admin-actions">
                      {u.status === 'blocked' ? (
                        <button
                          className="admin-action success"
                          disabled={busyAction === `user-${u.uid}`}
                          type="button"
                          onClick={() => void userAction(u.uid, 'unblock')}
                          title="Lever le bannissement"
                        >
                          <Unlock size={15} /> Débloquer
                        </button>
                      ) : (
                        <button
                          className="admin-action warn"
                          disabled={busyAction === `user-${u.uid}`}
                          type="button"
                          onClick={() => {
                            setBlockMessage('')
                            setBlockTarget(u)
                          }}
                          title="Bloquer ce compte"
                        >
                          <Ban size={15} /> Bloquer
                        </button>
                      )}
                      <button
                        className="admin-action danger"
                        disabled={
                          busyAction === `user-${u.uid}` ||
                          (u.banCount < 3 && !u.deletionRequest)
                        }
                        type="button"
                        onClick={() => {
                          setDeleteUserConfirm('')
                          setDeleteUserMessage('')
                          setDeleteUserNotifId(null)
                          setDeleteUserTarget(u)
                        }}
                        title={
                          u.banCount < 3 && !u.deletionRequest
                            ? `Suppression possible après 3 bannissements (${u.banCount}/3)`
                            : 'Supprimer définitivement le compte'
                        }
                      >
                        <Trash2 size={15} /> Supprimer
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ),
          )}
          {users.length === 0 ? (
            <tr><td className="admin-empty" colSpan={8}>Aucun utilisateur.</td></tr>
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
                      onClick={() => {
                        setUnpublishMessage('')
                        setUnpublishTarget(m)
                      }}
                      title="Repasser en brouillon"
                    >
                      <EyeOff size={15} /> Dépublier
                    </button>
                  ) : null}
                  <button
                    className="admin-action danger"
                    disabled={busyAction === `map-${m.code}`}
                    type="button"
                    onClick={() => {
                      setDeleteConfirm('')
                      setDeleteMessage('')
                      setDeleteTarget(m)
                    }}
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

  const sanctionStats = useMemo(() => {
    const weekAgo = new Date().getTime() - 7 * 24 * 60 * 60 * 1000
    const isAccount = (a: Sanction['action']) =>
      a === 'block' || a === 'unblock' || a === 'delete-account'
    return {
      total: sanctions.length,
      mapCount: sanctions.filter((s) => !isAccount(s.action)).length,
      accountCount: sanctions.filter((s) => isAccount(s.action)).length,
      recentCount: sanctions.filter(
        (s) => new Date(s.createdAt).getTime() >= weekAgo,
      ).length,
    }
  }, [sanctions])

  const sanctionBadge = (action: Sanction['action']): ReactNode => {
    switch (action) {
      case 'delete':
        return <span className="admin-sanction-badge delete"><Trash2 size={13} /> Suppression carte</span>
      case 'block':
        return <span className="admin-sanction-badge block"><Ban size={13} /> Blocage compte</span>
      case 'unblock':
        return <span className="admin-sanction-badge unblock"><Unlock size={13} /> Déblocage</span>
      case 'delete-account':
        return <span className="admin-sanction-badge delete-account"><Trash2 size={13} /> Suppression compte</span>
      default:
        return <span className="admin-sanction-badge unpublish"><EyeOff size={13} /> Dépublication</span>
    }
  }

  const sanctionsView = (() => {
    const { total, mapCount, accountCount, recentCount } = sanctionStats
    const isAccount = (a: Sanction['action']) =>
      a === 'block' || a === 'unblock' || a === 'delete-account'

    return (
      <>
        <section className="admin-stats" aria-label="Synthèse des sanctions">
          <article className="admin-stat-card featured">
            <span><Gavel size={18} /></span>
            <p>Total sanctions</p>
            <strong>{total}</strong>
          </article>
          <article className="admin-stat-card">
            <span><MapIcon size={18} /></span>
            <p>Sur des cartes</p>
            <strong>{mapCount}</strong>
          </article>
          <article className="admin-stat-card">
            <span><Ban size={18} /></span>
            <p>Sur des comptes</p>
            <strong>{accountCount}</strong>
          </article>
          <article className="admin-stat-card">
            <span><RefreshCw size={18} /></span>
            <p>7 derniers jours</p>
            <strong>{recentCount}</strong>
          </article>
        </section>

        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Cible</th>
                <th>Message</th>
                <th>Admin</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {sanctions.map((s) => (
                <tr key={s.id}>
                  <td>{sanctionBadge(s.action)}</td>
                  <td>
                    {isAccount(s.action) ? (
                      <div className="admin-user-cell">
                        <strong>{s.targetEmail ?? s.targetUid ?? s.ownerEmail ?? '—'}</strong>
                        <small>Compte utilisateur</small>
                      </div>
                    ) : (
                      <div className="admin-user-cell">
                        <strong>{s.mapTitle || s.mapCode}</strong>
                        <small>{s.mapCode}{s.ownerEmail ? ` · ${s.ownerEmail}` : ''}</small>
                      </div>
                    )}
                  </td>
                  <td className="admin-sanction-message">
                    {s.message ? s.message : <span className="admin-muted-text">—</span>}
                  </td>
                  <td>{s.adminEmail ?? s.adminUid}</td>
                  <td>{formatDateTime(s.createdAt)}</td>
                </tr>
              ))}
              {sanctions.length === 0 ? (
                <tr><td className="admin-empty" colSpan={5}>Aucune sanction enregistrée.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </>
    )
  })()

  const notificationsView = (
    <>
      <section className="admin-stats" aria-label="Synthèse des notifications">
        <article className="admin-stat-card featured">
          <span><Bell size={18} /></span>
          <p>Notifications</p>
          <strong>{notifications.length}</strong>
        </article>
        <article className="admin-stat-card">
          <span><Mail size={18} /></span>
          <p>Non lues</p>
          <strong>{unreadCount}</strong>
        </article>
        <article className="admin-stat-card">
          <span><Ban size={18} /></span>
          <p>Appels de bannis</p>
          <strong>{notifications.filter((n) => n.type === 'appeal').length}</strong>
        </article>
        <article className="admin-stat-card">
          <span><RefreshCw size={18} /></span>
          <p>7 derniers jours</p>
          <strong>
            {notifications.filter(
              (n) =>
                new Date(n.createdAt).getTime() >=
                new Date().getTime() - 7 * 24 * 60 * 60 * 1000,
            ).length}
          </strong>
        </article>
      </section>

      <div className="admin-notif-list">
        {unreadCount > 0 ? (
          <button
            className="admin-refresh admin-notif-readall"
            type="button"
            onClick={() =>
              void markNotificationsRead(
                notifications.filter((n) => !n.read).map((n) => n.id),
              )
            }
          >
            Tout marquer comme lu
          </button>
        ) : null}
        {notifications.map((n) => (
          <article className={`admin-notif-card${n.read ? '' : ' unread'}`} key={n.id}>
            <div className="admin-notif-head">
              <span className="admin-notif-from">
                {n.type === 'deletion-request' ? (
                  <>
                    <Trash2 size={14} /> Demande de suppression de{' '}
                    {n.fromEmail ?? n.fromUid}
                  </>
                ) : (
                  <>
                    <Ban size={14} /> Appel de {n.fromEmail ?? n.fromUid}
                  </>
                )}
              </span>
              <time>{formatDateTime(n.createdAt)}</time>
            </div>
            <p className="admin-notif-message">{n.message}</p>
            {n.reply ? (
              <div className="admin-notif-reply">
                <span>Votre réponse</span>
                <p>{n.reply.message}</p>
              </div>
            ) : null}
            <div className="admin-notif-actions">
              {n.type === 'deletion-request' ? (
                <>
                  <button
                    className="admin-notif-mark danger"
                    type="button"
                    disabled={busyAction === `user-${n.fromUid}`}
                    onClick={() => {
                      const target = users.find((u) => u.uid === n.fromUid)
                      if (!target) {
                        setError('Compte introuvable (déjà supprimé ?).')
                        return
                      }
                      setDeleteUserConfirm('')
                      setDeleteUserMessage('')
                      setDeleteUserNotifId(n.id)
                      setDeleteUserTarget(target)
                    }}
                  >
                    <Trash2 size={14} /> Supprimer le compte
                  </button>
                  <button
                    className="admin-notif-mark"
                    type="button"
                    disabled={busyAction === `user-${n.fromUid}`}
                    onClick={() =>
                      void userAction(
                        n.fromUid,
                        'dismiss-deletion-request',
                        undefined,
                        n.id,
                      )
                    }
                  >
                    Ignorer la demande
                  </button>
                </>
              ) : (
                <button
                  className="admin-notif-mark primary"
                  type="button"
                  onClick={() => {
                    setReplyMessage(n.reply?.message ?? '')
                    setReplyTarget(n)
                  }}
                >
                  {n.reply ? 'Modifier la réponse' : 'Répondre'}
                </button>
              )}
              {!n.read ? (
                <button
                  className="admin-notif-mark"
                  type="button"
                  onClick={() => void markNotificationsRead([n.id])}
                >
                  Marquer comme lu
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {notifications.length === 0 ? (
          <p className="admin-empty">Aucune notification.</p>
        ) : null}
      </div>
    </>
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
              {item.badge ? <span className="admin-nav-badge">{item.badge}</span> : null}
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
          ) : section === 'sanctions' ? (
            sanctionsView
          ) : section === 'notifications' ? (
            notificationsView
          ) : (
            storagePanels
          )}
        </div>
      </main>

      {unpublishTarget ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
          <div className="admin-modal">
            <h2>Dépublier « {unpublishTarget.title} »</h2>
            <p>
              La carte repasse en brouillon. Le message ci-dessous sera affiché à
              son propriétaire ({unpublishTarget.ownerEmail ?? unpublishTarget.ownerId})
              à sa prochaine connexion.
            </p>
            <textarea
              autoFocus
              className="admin-modal-textarea"
              placeholder="Ex : Votre carte a été dépubliée car elle ne respecte pas…"
              value={unpublishMessage}
              onChange={(event) => setUnpublishMessage(event.target.value)}
            />
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                type="button"
                onClick={() => setUnpublishTarget(null)}
              >
                Annuler
              </button>
              <button
                className="admin-modal-validate"
                disabled={
                  !unpublishMessage.trim() ||
                  busyAction === `map-${unpublishTarget.code}`
                }
                type="button"
                onClick={async () => {
                  const target = unpublishTarget
                  await mapAction(target.code, 'unpublish', {
                    message: unpublishMessage,
                    title: target.title,
                  })
                  setUnpublishTarget(null)
                }}
              >
                Valider et dépublier
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
          <div className="admin-modal">
            <h2 className="admin-modal-danger">
              <Trash2 size={18} /> Supprimer « {deleteTarget.title} »
            </h2>
            <p>
              Action <strong>définitive et irréversible</strong>. La carte, ses
              {' '}{deleteTarget.mediaCount} média(s) et son dossier de stockage R2
              seront supprimés. Le propriétaire
              ({deleteTarget.ownerEmail ?? deleteTarget.ownerId}) perdra la carte
              sans possibilité de récupération.
            </p>
            <label className="admin-modal-label" htmlFor="delete-message">
              Message au propriétaire (facultatif, affiché à sa prochaine connexion)
            </label>
            <textarea
              className="admin-modal-textarea"
              id="delete-message"
              placeholder="Ex : Votre carte a été supprimée car…"
              value={deleteMessage}
              onChange={(event) => setDeleteMessage(event.target.value)}
            />
            <p className="admin-modal-instruction">
              Pour confirmer, tape <code>delete</code> ci-dessous.
            </p>
            <input
              autoFocus
              className="admin-modal-input"
              placeholder="delete"
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
            />
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                type="button"
                onClick={() => setDeleteTarget(null)}
              >
                Annuler
              </button>
              <button
                className="admin-modal-delete"
                disabled={
                  deleteConfirm.trim().toLowerCase() !== 'delete' ||
                  busyAction === `map-${deleteTarget.code}`
                }
                type="button"
                onClick={async () => {
                  const target = deleteTarget
                  await mapAction(target.code, 'delete', {
                    message: deleteMessage,
                    title: target.title,
                  })
                  setDeleteTarget(null)
                }}
              >
                <Trash2 size={15} /> Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {blockTarget ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
          <div className="admin-modal">
            <h2 className="admin-modal-danger"><Ban size={18} /> Bloquer ce compte</h2>
            <p>
              {blockTarget.email ?? blockTarget.uid} n’aura plus accès à son
              espace : il ne verra qu’un écran de blocage avec le message
              ci-dessous, et pourra t’envoyer un seul message. ({blockTarget.banCount} bannissement(s) déjà reçu(s))
            </p>
            <label className="admin-modal-label" htmlFor="block-message">
              Message d’explication (affiché à l’utilisateur, obligatoire)
            </label>
            <textarea
              autoFocus
              className="admin-modal-textarea"
              id="block-message"
              placeholder="Ex : Votre compte est suspendu car…"
              value={blockMessage}
              onChange={(event) => setBlockMessage(event.target.value)}
            />
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                type="button"
                onClick={() => setBlockTarget(null)}
              >
                Annuler
              </button>
              <button
                className="admin-modal-delete"
                disabled={
                  !blockMessage.trim() || busyAction === `user-${blockTarget.uid}`
                }
                type="button"
                onClick={async () => {
                  const target = blockTarget
                  await userAction(target.uid, 'block', blockMessage)
                  setBlockTarget(null)
                }}
              >
                <Ban size={15} /> Bloquer le compte
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteUserTarget ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
          <div className="admin-modal">
            <h2 className="admin-modal-danger">
              <Trash2 size={18} /> Supprimer le compte
            </h2>
            <p>
              Action <strong>définitive</strong> sur {deleteUserTarget.email ?? deleteUserTarget.uid}.
              Tout son contenu (cartes, médias, stockage R2) est effacé.{' '}
              {deleteUserTarget.deletionRequest ? (
                <>
                  Suppression <strong>demandée par l’utilisateur</strong> : son
                  adresse email est libérée, il pourra se réinscrire.
                </>
              ) : (
                <>
                  Le compte et l’adresse email restent <strong>réservés</strong> :
                  l’utilisateur ne pourra plus se reconnecter ni recréer un compte
                  avec cette adresse.
                </>
              )}
            </p>
            <label className="admin-modal-label" htmlFor="deluser-message">
              Message au propriétaire (facultatif, affiché à sa prochaine connexion)
            </label>
            <textarea
              className="admin-modal-textarea"
              id="deluser-message"
              placeholder="Ex : Votre compte a été supprimé suite à…"
              value={deleteUserMessage}
              onChange={(event) => setDeleteUserMessage(event.target.value)}
            />
            <p className="admin-modal-instruction">
              Pour confirmer, tape <code>delete</code> ci-dessous.
            </p>
            <input
              className="admin-modal-input"
              placeholder="delete"
              value={deleteUserConfirm}
              onChange={(event) => setDeleteUserConfirm(event.target.value)}
            />
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                type="button"
                onClick={() => {
                  setDeleteUserTarget(null)
                  setDeleteUserNotifId(null)
                }}
              >
                Annuler
              </button>
              <button
                className="admin-modal-delete"
                disabled={
                  deleteUserConfirm.trim().toLowerCase() !== 'delete' ||
                  busyAction === `user-${deleteUserTarget.uid}`
                }
                type="button"
                onClick={async () => {
                  const target = deleteUserTarget
                  const notifId = deleteUserNotifId
                  await userAction(
                    target.uid,
                    'delete-account',
                    deleteUserMessage,
                    notifId ?? undefined,
                  )
                  setDeleteUserTarget(null)
                  setDeleteUserNotifId(null)
                }}
              >
                <Trash2 size={15} /> Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {replyTarget ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
          <div className="admin-modal">
            <h2>Répondre à {replyTarget.fromEmail ?? replyTarget.fromUid}</h2>
            <p>Son message : « {replyTarget.message} »</p>
            <label className="admin-modal-label" htmlFor="reply-message">
              Votre réponse (affichée sur son écran de blocage)
            </label>
            <textarea
              autoFocus
              className="admin-modal-textarea"
              id="reply-message"
              placeholder="Votre réponse…"
              value={replyMessage}
              onChange={(event) => setReplyMessage(event.target.value)}
            />
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                type="button"
                onClick={() => setReplyTarget(null)}
              >
                Annuler
              </button>
              <button
                className="admin-modal-validate"
                disabled={
                  !replyMessage.trim() || busyAction === `reply-${replyTarget.id}`
                }
                type="button"
                onClick={async () => {
                  const target = replyTarget
                  await replyToAppeal(target, replyMessage.trim())
                  setReplyTarget(null)
                }}
              >
                Envoyer la réponse
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
