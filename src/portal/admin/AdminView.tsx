import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  AlertTriangle,
  Ban,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Database,
  Euro,
  ExternalLink,
  EyeOff,
  Film,
  Gavel,
  HardDrive,
  Image as ImageIcon,
  LayoutDashboard,
  LineChart,
  LogOut,
  Map as MapIcon,
  Mail,
  RefreshCw,
  Scale,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TrendingUp,
  Unlock,
  Users,
  Wallet,
} from 'lucide-react'
import type { PortalUser } from '../portalStore'
import { getIdToken } from '../firebase'
import { requestMediaTicket, startMediaTicketRefresh } from '../../lib/mediaTicket'
import { PLANS, formatBytes, type PlanId } from '../plans'
import { UserGrowthChart, type ChartSeries } from './UserGrowthChart'
import './Admin.css'

type AdminUser = {
  uid: string
  email: string | null
  name?: string
  plan: string
  isAdmin: boolean
  internal: boolean
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

// Un média flaggé/rejeté par la modération IA (enrichi côté serveur : URL d'aperçu
// via le videur, email du propriétaire, code/titre de la carte).
type MediaModItem = {
  id: string
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  status: 'flagged' | 'rejected'
  aiCategory: string
  aiScore: number
  scannedAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  mediaUrl: string
  ownerEmail: string | null
  mapCode: string
  mapTitle: string
}

// Une entrée de l'inventaire complet (tous les originaux + leur état de modération),
// enrichie côté serveur comme les médias flaggés.
type MediaInventoryItem = {
  id: string
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  sizeBytes: number
  scanned: boolean
  exempt: boolean
  aiStatus: 'pending' | 'exempt' | 'ok' | 'flagged' | 'rejected'
  adminStatus: 'none' | 'to-review' | 'rejected'
  aiCategory: string | null
  aiScore: number | null
  reviewedAt: string | null
  reviewedBy: string | null
  mediaUrl: string
  ownerEmail: string | null
  mapCode: string
  mapTitle: string
}

type MediaReviewAsset = {
  id: string
  mediaKind: 'image' | 'video'
  mediaUrl: string
}

type MediaReviewGroup = {
  id: string
  ids: string[]
  items: MediaModItem[]
  primary: MediaModItem
  scoreItem: MediaModItem
  original: MediaReviewAsset
  thumbnail: MediaReviewAsset | null
  label: string
}

type MediaModerationHistoryItem = {
  id: string
  decision: 'approved' | 'rejected'
  mediaIds: string[]
  ownerUid: string
  mapFolder: string
  mediaKind: 'image' | 'video'
  aiCategory: string
  aiScore: number
  decidedAt: string
  decidedBy: string
  decidedByEmail: string | null
  message: string
  source: 'admin' | 'auto'
  ownerEmail: string | null
  mapCode: string
  mapTitle: string
}

type MediaModUsage = {
  day: string
  dayOps: number
  month: string
  monthOps: number
  updatedAt: string
} | null

type MediaModeration = {
  items: MediaModItem[]
  inventory: MediaInventoryItem[]
  history: MediaModerationHistoryItem[]
  usage: MediaModUsage
  dailyLimit: number
  monthlyLimit: number
}

type Overview = {
  userCount: number
  hikeCount: number
  publishedCount: number
  draftCount: number
  totalBytes: number
  internalBytes: number
  billableBytes: number
  monthlyCostEur: number
}

type EmailUsage = {
  configured: boolean
  dailyUsed: number | null
  dailyLimit: number
  monthlyUsed: number | null
  monthlyLimit: number
  updatedAt: string | null
}

type AdminSection =
  | 'overview'
  | 'costs'
  | 'users'
  | 'maps'
  | 'sanctions'
  | 'media-moderation'
  | 'media-inventory'
  | 'notifications'
  | 'storage'

const SECTION_TITLES: Record<AdminSection, string> = {
  overview: 'Vue d’ensemble',
  costs: 'Coûts',
  users: 'Utilisateurs',
  maps: 'Cartes',
  sanctions: 'Sanctions',
  'media-moderation': 'Modération IA',
  'media-inventory': 'Tous les médias',
  notifications: 'Notifications',
  storage: 'Stockage R2',
}

type CostPlatform = {
  id: string
  name: string
  detail: string
  model: 'usage' | 'free' | 'fixed'
  monthlyEur: number
  renewsAt: string | null
}

type Costs = {
  platforms: CostPlatform[]
  totalMonthlyEur: number
}

const isOriginalMediaKey = (id: string): boolean => id.includes('/media/')
const isPreviewMediaKey = (id: string): boolean => id.includes('/previews/')

const mediaReviewGroupKey = (id: string): string => {
  const marker = isOriginalMediaKey(id)
    ? '/media/'
    : isPreviewMediaKey(id)
      ? '/previews/'
      : ''
  if (!marker) return id

  const markerIndex = id.indexOf(marker)
  const prefix = id.slice(0, markerIndex)
  const fileName = id.slice(markerIndex + marker.length).split('/').pop() ?? ''
  const fingerprint =
    marker === '/media/'
      ? fileName.split('-')[0] || fileName
      : fileName.replace(/\.[^.]+$/, '')

  return `${prefix}/${fingerprint}`
}

const toReviewAsset = (
  item: MediaModItem | MediaInventoryItem,
): MediaReviewAsset => ({
  id: item.id,
  mediaKind: item.mediaKind,
  mediaUrl: item.mediaUrl,
})

const buildMediaReviewGroups = (
  items: MediaModItem[],
  inventory: MediaInventoryItem[],
): MediaReviewGroup[] => {
  const inventoryByGroup = new Map(
    inventory.map((item) => [mediaReviewGroupKey(item.id), item]),
  )
  const grouped = new Map<string, MediaModItem[]>()

  for (const item of items.filter((entry) => entry.status === 'flagged')) {
    const key = mediaReviewGroupKey(item.id)
    grouped.set(key, [...(grouped.get(key) ?? []), item])
  }

  return [...grouped.entries()]
    .map(([key, groupItems]) => {
      const originalItem = groupItems.find((item) => isOriginalMediaKey(item.id))
      const thumbnailItem = groupItems.find((item) => isPreviewMediaKey(item.id))
      const inventoryOriginal = inventoryByGroup.get(key)
      const primary = originalItem ?? groupItems[0]
      const scoreItem = groupItems.reduce((best, item) =>
        item.aiScore > best.aiScore ? item : best,
      )
      const original = toReviewAsset(originalItem ?? inventoryOriginal ?? primary)
      const thumbnail =
        thumbnailItem && thumbnailItem.id !== original.id
          ? toReviewAsset(thumbnailItem)
          : null
      const label =
        originalItem && thumbnailItem
          ? 'Original + vignette'
          : thumbnailItem
            ? 'Vignette signalee'
            : 'Original signale'

      return {
        id: key,
        ids: groupItems.map((item) => item.id),
        items: groupItems,
        primary,
        scoreItem,
        original,
        thumbnail,
        label,
      }
    })
    .sort(
      (a, b) =>
        new Date(b.scoreItem.scannedAt).getTime() -
        new Date(a.scoreItem.scannedAt).getTime(),
    )
}

const renderReviewAsset = (
  asset: MediaReviewAsset,
  alt: string,
  className?: string,
): ReactNode =>
  asset.mediaKind === 'video' ? (
    <video
      className={className}
      src={asset.mediaUrl}
      controls
      preload="metadata"
      crossOrigin="use-credentials"
    />
  ) : (
    <img
      className={className}
      src={asset.mediaUrl}
      alt={alt}
      crossOrigin="use-credentials"
    />
  )

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const dateInputValue = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

const dateInputBoundary = (
  value: string,
  boundary: 'start' | 'end',
): number => {
  if (!value) return boundary === 'start' ? -Infinity : Infinity
  const suffix = boundary === 'start' ? 'T00:00:00' : 'T23:59:59.999'
  const time = new Date(`${value}${suffix}`).getTime()
  return Number.isFinite(time)
    ? time
    : boundary === 'start'
      ? -Infinity
      : Infinity
}

const dayKeyFromIso = (value: string): string => dateInputValue(new Date(value))

const formatDayLabel = (day: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
  }).format(new Date(`${day}T12:00:00`))

// Libellés + couleurs des pastilles de l'inventaire des médias.
const INVENTORY_AI_PILL: Record<
  MediaInventoryItem['aiStatus'],
  { label: string; cls: string }
> = {
  pending: { label: 'En attente', cls: 'warn' },
  exempt: { label: 'Exempté', cls: 'neutral' },
  ok: { label: 'Validé', cls: 'ok' },
  flagged: { label: 'Signalé', cls: 'danger' },
  rejected: { label: 'Rejeté', cls: 'danger' },
}
const INVENTORY_ADMIN_PILL: Record<
  MediaInventoryItem['adminStatus'],
  { label: string; cls: string }
> = {
  none: { label: '—', cls: 'muted' },
  'to-review': { label: 'À traiter', cls: 'warn' },
  rejected: { label: 'Rejeté', cls: 'danger' },
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

// Jauge de consommation d'emails (utilisé / limite) avec code couleur.
function EmailQuotaBar({
  label,
  used,
  limit,
}: {
  label: string
  used: number | null
  limit: number
}) {
  const known = typeof used === 'number'
  const pct = known ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const level = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'ok'
  return (
    <div className="admin-email-quota">
      <div className="admin-email-quota-head">
        <span>{label}</span>
        <strong>{known ? `${used} / ${limit}` : `— / ${limit}`}</strong>
      </div>
      <div className="admin-email-bar">
        <div
          className={`admin-email-bar-fill ${level}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <small>{known ? `${pct}%` : 'En attente de données'}</small>
    </div>
  )
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
  const [email, setEmail] = useState<EmailUsage | null>(null)
  const [costs, setCosts] = useState<Costs | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [maps, setMaps] = useState<AdminMap[]>([])
  const [sanctions, setSanctions] = useState<Sanction[]>([])
  const [notifications, setNotifications] = useState<AdminNotification[]>([])
  const [mediaMod, setMediaMod] = useState<MediaModeration | null>(null)
  // Modale de rejet d'un média + message transmis au propriétaire.
  const [rejectMediaTarget, setRejectMediaTarget] = useState<MediaReviewGroup | null>(null)
  const [rejectMediaMessage, setRejectMediaMessage] = useState('')
  // Retour du dernier scan déclenché à la main.
  const [scanInfo, setScanInfo] = useState<string | null>(null)
  const [mediaHistoryFrom, setMediaHistoryFrom] = useState(() =>
    dateInputValue(addDays(new Date(), -29)),
  )
  const [mediaHistoryTo, setMediaHistoryTo] = useState(() =>
    dateInputValue(new Date()),
  )
  // Inventaire des médias : tri primaire (par utilisateur ou par carte).
  const [inventorySort, setInventorySort] = useState<'user' | 'map'>('user')
  // Groupes repliés de l'inventaire (clés `g:<groupe>` niveau 1, `s:<groupe>»<sous>` niveau 2).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  )
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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

  const load = useCallback(async (silent = false) => {
    try {
      const token = await getIdToken()
      if (!token) throw new Error('Connexion requise.')
      // Rafraîchissement silencieux (auto-refresh) : on ne repasse pas l'écran en
      // « chargement » pour ne pas faire clignoter la vue.
      if (!silent) setLoading(true)
      setError(null)
      const headers = { Authorization: `Bearer ${token}` }
      // Ticket « scope all » (admin) posé AVANT de rendre les covers de la console.
      await requestMediaTicket({ scope: 'all' }, token)
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
        email: EmailUsage
        costs: Costs
        mediaModeration: MediaModeration
      }
      setOverview(data.overview)
      setUsers(data.users)
      setMaps(data.maps)
      setSanctions(data.sanctions)
      setNotifications(data.notifications)
      setEmail(data.email)
      setCosts(data.costs)
      setMediaMod(data.mediaModeration)
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

  // Sur l'onglet Modération IA, rafraîchissement silencieux périodique : l'inventaire
  // et la file de revue se mettent à jour au fur et à mesure des scans (cron, callbacks
  // vidéo) sans intervention. Inactif ailleurs pour ne pas relister R2 en boucle.
  useEffect(() => {
    if (section !== 'media-moderation' && section !== 'media-inventory') return
    const timer = setInterval(() => void load(true), 12_000)
    return () => clearInterval(timer)
  }, [section, load])

  // Inventaire en arborescence à deux niveaux : groupe primaire (utilisateur ou
  // carte selon le tri) → groupe secondaire (l'autre) → médias. Trié à chaque cran.
  const inventoryTree = useMemo(() => {
    const inventory = mediaMod?.inventory ?? []
    const primary = (item: MediaInventoryItem) =>
      inventorySort === 'user' ? item.ownerEmail ?? item.ownerUid : item.mapTitle
    const secondary = (item: MediaInventoryItem) =>
      inventorySort === 'user' ? item.mapTitle : item.ownerEmail ?? item.ownerUid
    const sorted = [...inventory].sort(
      (a, b) =>
        primary(a).localeCompare(primary(b)) ||
        secondary(a).localeCompare(secondary(b)) ||
        a.id.localeCompare(b.id),
    )
    const tree: {
      label: string
      count: number
      subs: { label: string; items: MediaInventoryItem[] }[]
    }[] = []
    for (const item of sorted) {
      const groupLabel = primary(item)
      const subLabel = secondary(item)
      let group = tree[tree.length - 1]
      if (!group || group.label !== groupLabel) {
        group = { label: groupLabel, count: 0, subs: [] }
        tree.push(group)
      }
      group.count += 1
      let sub = group.subs[group.subs.length - 1]
      if (!sub || sub.label !== subLabel) {
        sub = { label: subLabel, items: [] }
        group.subs.push(sub)
      }
      sub.items.push(item)
    }
    return tree
  }, [mediaMod?.inventory, inventorySort])

  // Renouvellement du ticket d'accès média « scope all » (covers de la console).
  useEffect(() => startMediaTicketRefresh({ scope: 'all' }, getIdToken), [])

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

  // Modération IA : lance un scan à la demande et affiche le rapport du videur.
  const scanMedia = async () => {
    setBusyAction('scan-media')
    setScanInfo('Scan en cours…')
    try {
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan-media' }),
      })
      const data = (await response.json().catch(() => null)) as {
        report?: {
          ok: boolean
          reason?: string
          processed: number
          flagged: number
          videosSubmitted: number
          capReached: boolean
        } | null
        autoRemoved?: number
        configured?: boolean
      } | null
      const report = data?.report
      const autoRemoved = data?.autoRemoved ?? 0
      if (!report) {
        // Pas de rapport : soit la modération n'est pas configurée, soit le scan a
        // dépassé ~9 s (limite Vercel) et continue en arrière-plan dans le videur.
        setScanInfo(
          data?.configured
            ? 'Scan lancé : il continue en arrière-plan (gros lot ou vidéos). Relance dans un instant pour voir le reste.'
            : 'Modération non configurée (aucun compte Sightengine) : le scan reste inactif.',
        )
      } else if (!report.ok) {
        setScanInfo(report.reason ?? 'Scan indisponible.')
      } else {
        setScanInfo(
          `Scan terminé : ${report.processed} média(s) traité(s), ${report.flagged} flaggé(s)` +
            `${report.videosSubmitted ? `, ${report.videosSubmitted} vidéo(s) en analyse` : ''}` +
            `${autoRemoved ? `, ${autoRemoved} supprimé(s) automatiquement` : ''}` +
            `${report.capReached ? ' · cap quotidien atteint' : ''}.`,
        )
      }
      await load()
    } catch {
      setScanInfo('Scan impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  const approveMedia = async (group: MediaReviewGroup) => {
    setBusyAction(`media-${group.id}`)
    try {
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'media-mod',
          op: 'approve',
          id: group.primary.id,
          ids: group.ids,
        }),
      })
      if (!response.ok) throw new Error()
      const approved = new Set(group.ids)
      setMediaMod((current) =>
        current
          ? { ...current, items: current.items.filter((i) => !approved.has(i.id)) }
          : current,
      )
      await load(true)
    } catch {
      setError('Approbation du média impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  const rejectMedia = async (group: MediaReviewGroup, message: string) => {
    setBusyAction(`media-${group.id}`)
    try {
      const response = await authFetch('/api/admin/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'media-mod',
          op: 'reject',
          id: group.primary.id,
          uid: group.primary.ownerUid,
          code: group.primary.mapCode,
          title: group.primary.mapTitle,
          message,
        }),
      })
      if (!response.ok) throw new Error()
      await load()
    } catch {
      setError('Rejet du média impossible.')
    } finally {
      setBusyAction(null)
    }
  }

  // Revenus + évolution des inscriptions, dérivés de la liste des utilisateurs.
  // On exclut l'admin (ne paie pas) et les comptes supprimés (plus d'abonnement).
  const analytics = useMemo(() => {
    const clients = users.filter((u) => !u.isAdmin && u.status !== 'deleted')
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
  const mediaReviewGroups = useMemo(
    () => buildMediaReviewGroups(mediaMod?.items ?? [], mediaMod?.inventory ?? []),
    [mediaMod?.inventory, mediaMod?.items],
  )
  const setMediaHistoryPreset = (days: number | 'all') => {
    if (days === 'all') {
      setMediaHistoryFrom('')
      setMediaHistoryTo('')
      return
    }
    const today = new Date()
    setMediaHistoryFrom(dateInputValue(addDays(today, -(days - 1))))
    setMediaHistoryTo(dateInputValue(today))
  }
  const mediaHistoryStats = useMemo(() => {
    const fromMs = dateInputBoundary(mediaHistoryFrom, 'start')
    const toMs = dateInputBoundary(mediaHistoryTo, 'end')
    const filtered = (mediaMod?.history ?? [])
      .filter((entry) => {
        const time = new Date(entry.decidedAt).getTime()
        return Number.isFinite(time) && time >= fromMs && time <= toMs
      })
      .sort(
        (a, b) =>
          new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime(),
      )

    const dayMap = new Map<string, { approved: number; rejected: number }>()
    for (const entry of filtered) {
      const day = dayKeyFromIso(entry.decidedAt)
      const current = dayMap.get(day) ?? { approved: 0, rejected: 0 }
      current[entry.decision] += 1
      dayMap.set(day, current)
    }

    const days: Array<{ day: string; approved: number; rejected: number }> = []
    const fromDate = mediaHistoryFrom
      ? new Date(`${mediaHistoryFrom}T00:00:00`)
      : null
    const toDate = mediaHistoryTo ? new Date(`${mediaHistoryTo}T00:00:00`) : null
    if (
      fromDate &&
      toDate &&
      Number.isFinite(fromDate.getTime()) &&
      Number.isFinite(toDate.getTime()) &&
      fromDate <= toDate
    ) {
      const cursor = new Date(fromDate)
      let guard = 0
      while (cursor <= toDate && guard < 370) {
        const day = dateInputValue(cursor)
        const counts = dayMap.get(day) ?? { approved: 0, rejected: 0 }
        days.push({ day, ...counts })
        cursor.setDate(cursor.getDate() + 1)
        guard += 1
      }
    } else {
      for (const day of [...dayMap.keys()].sort()) {
        const counts = dayMap.get(day) ?? { approved: 0, rejected: 0 }
        days.push({ day, ...counts })
      }
    }

    const approvedCount = filtered.filter(
      (entry) => entry.decision === 'approved',
    ).length
    const rejectedCount = filtered.filter(
      (entry) => entry.decision === 'rejected',
    ).length
    const autoRejectedCount = filtered.filter(
      (entry) => entry.decision === 'rejected' && entry.source === 'auto',
    ).length
    const maxRejected = Math.max(1, ...days.map((day) => day.rejected))

    return {
      filtered,
      days,
      approvedCount,
      rejectedCount,
      autoRejectedCount,
      maxRejected,
    }
  }, [mediaHistoryFrom, mediaHistoryTo, mediaMod?.history])

  const navItems: Array<{ id: AdminSection; label: string; icon: ReactNode; badge?: number }> = [
    { id: 'overview', label: 'Vue d’ensemble', icon: <LayoutDashboard size={18} /> },
    { id: 'costs', label: 'Coûts', icon: <Wallet size={18} /> },
    { id: 'users', label: 'Utilisateurs', icon: <Users size={18} /> },
    { id: 'maps', label: 'Cartes', icon: <MapIcon size={18} /> },
    { id: 'sanctions', label: 'Sanctions', icon: <Gavel size={18} /> },
    {
      id: 'media-moderation',
      label: 'Modération IA',
      icon: <ShieldAlert size={18} />,
      badge: mediaReviewGroups.length || undefined,
    },
    { id: 'media-inventory', label: 'Médias', icon: <ImageIcon size={18} /> },
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
        <small>dont {overview ? formatBytes(overview.internalBytes) : '—'} interne (tests)</small>
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
          <div><dt>Interne (tests, non facturé)</dt><dd>{overview ? formatBytes(overview.internalBytes) : '—'}</dd></div>
          <div><dt>Volume facturé</dt><dd>{overview ? formatBytes(overview.billableBytes) : '—'}</dd></div>
          <div><dt>Coût mensuel</dt><dd className="admin-cost">{overview ? formatEur(overview.monthlyCostEur) : '—'}</dd></div>
        </dl>
        <p className="admin-note">
          Les comptes internes (admin, perso, tests) ne sont pas facturés : les
          10 Go gratuits de R2 leur sont attribués. Les vrais utilisateurs sont
          comptés au Go plein, ~0,015 €/Go/mois (sortie de données gratuite).
        </p>
      </article>
      <article className="admin-storage-card">
        <h2>Top consommateurs</h2>
        <ul className="admin-top-users">
          {users
            .filter((u) => !u.internal && u.usedBytes > 0)
            .sort((a, b) => b.usedBytes - a.usedBytes)
            .slice(0, 8)
            .map((u) => (
              <li key={u.uid}>
                <span>{u.name || u.email || u.uid}</span>
                <strong>{formatBytes(u.usedBytes)}</strong>
                <small>{formatEur(u.monthlyCostEur)}/mois</small>
              </li>
            ))}
          {users.filter((u) => !u.internal && u.usedBytes > 0).length === 0 ? (
            <li className="admin-empty">Aucun consommateur pour l’instant.</li>
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

  const emailPanel = (
    <section className="admin-panel" aria-label="Emails Resend">
      <header className="admin-panel-head">
        <h2><Mail size={18} /> Emails (Resend)</h2>
        <p>
          {email?.configured
            ? 'Consommation du compte (transactionnel + marketing), lue chez Resend.'
            : 'Fournisseur non configuré : aucun email envoyé via Resend pour l’instant.'}
        </p>
      </header>
      <div className="admin-email-quotas">
        <EmailQuotaBar
          label="Aujourd’hui"
          used={email?.dailyUsed ?? null}
          limit={email?.dailyLimit ?? 100}
        />
        <EmailQuotaBar
          label="Ce mois"
          used={email?.monthlyUsed ?? null}
          limit={email?.monthlyLimit ?? 3000}
        />
      </div>
      <p className="admin-email-foot">
        {email?.updatedAt
          ? `Dernière mesure : ${formatDateTime(email.updatedAt)}. Le compteur se met à jour à chaque envoi de l’app ; la page Usage de Resend reste la source temps réel.`
          : 'Aucune mesure encore : les compteurs apparaîtront au premier envoi.'}
      </p>
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

  const costsView = (() => {
    const totalCosts = costs?.totalMonthlyEur ?? 0
    const mrr = analytics.mrr
    const balance = mrr - totalCosts
    const topConsumers = [...users]
      .filter((u) => !u.internal && u.usedBytes > 0)
      .sort((a, b) => b.monthlyCostEur - a.monthlyCostEur)
      .slice(0, 5)
    const modelLabel = (model: CostPlatform['model']) =>
      model === 'usage' ? 'À l’usage' : model === 'fixed' ? 'Fixe' : 'Gratuit'
    return (
      <>
        <section className="admin-stats" aria-label="Balance budgétaire">
          <article className="admin-stat-card featured">
            <span><Scale size={18} /></span>
            <p>Balance mensuelle</p>
            <strong style={{ color: balance >= 0 ? '#9be7c4' : '#ffb3ad' }}>
              {formatEur(balance)}
            </strong>
            <small>
              {balance >= 0 ? 'Bénéfice' : 'Perte'} · {formatEur(balance * 12)}/an
            </small>
          </article>
          <article className="admin-stat-card">
            <span><Euro size={18} /></span>
            <p>Revenus / mois</p>
            <strong>{formatEur(mrr)}</strong>
            <small>MRR des forfaits payants</small>
          </article>
          <article className="admin-stat-card">
            <span><Wallet size={18} /></span>
            <p>Coûts / mois</p>
            <strong>{formatEur(totalCosts)}</strong>
            <small>toutes plateformes</small>
          </article>
        </section>

        <section className="admin-panel" aria-label="Coûts par plateforme">
          <header className="admin-panel-head">
            <h2><Database size={18} /> Coûts par plateforme</h2>
            <p>Calculés depuis l’usage réel ou les abonnements connus. Aucune saisie manuelle.</p>
          </header>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr><th>Plateforme</th><th>Type</th><th>Détail</th><th>Coût / mois</th></tr>
              </thead>
              <tbody>
                {(costs?.platforms ?? []).map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td>{modelLabel(p.model)}</td>
                    <td>
                      {p.detail}
                      {p.renewsAt ? ` · échéance ${formatDate(p.renewsAt)}` : ''}
                    </td>
                    <td>
                      {p.model === 'free' && p.monthlyEur === 0
                        ? 'Gratuit'
                        : formatEur(p.monthlyEur)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}><strong>Total mensuel</strong></td>
                  <td><strong>{formatEur(totalCosts)}</strong></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section className="admin-panel" aria-label="R2 top consommateurs">
          <header className="admin-panel-head">
            <h2><HardDrive size={18} /> R2 : top consommateurs</h2>
            <p>Les comptes qui pèsent le plus dans le coût de stockage.</p>
          </header>
          {topConsumers.length > 0 ? (
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr><th>Utilisateur</th><th>Stockage</th><th>Coût / mois</th></tr>
                </thead>
                <tbody>
                  {topConsumers.map((u) => (
                    <tr key={u.uid}>
                      <td>{u.name || u.email || u.uid}</td>
                      <td>{formatBytes(u.usedBytes)}</td>
                      <td>{formatEur(u.monthlyCostEur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="admin-empty">Aucun stockage facturé pour l’instant.</p>
          )}
        </section>
      </>
    )
  })()

  // Inventaire complet : tous les originaux en arborescence repliable (utilisateur ▸
  // carte ▸ médias, ou l'inverse), avec leur état (vérifié / non / exempté), le
  // verdict IA et la décision admin.
  const inventoryTable = (() => {
    const total = mediaMod?.inventory?.length ?? 0
    const collapseAll = () =>
      setCollapsedGroups(new Set(inventoryTree.map((group) => `g:${group.label}`)))
    const mediaRow = (item: MediaInventoryItem) => {
      const ai = INVENTORY_AI_PILL[item.aiStatus]
      const adm = INVENTORY_ADMIN_PILL[item.adminStatus]
      return (
        <tr key={item.id}>
          <td>
            <div className="admin-inv-media">
              <span className="admin-inv-thumb">
                {item.mediaKind === 'video' ? (
                  <Film size={16} />
                ) : (
                  <img
                    src={item.mediaUrl}
                    alt=""
                    crossOrigin="use-credentials"
                    loading="lazy"
                  />
                )}
              </span>
              <span className="admin-inv-media-meta">
                <small title={item.id}>
                  {decodeURIComponent(item.id.split('/').pop() ?? '')}
                </small>
                {item.sizeBytes <= 0 ? (
                  <small className="admin-inv-broken">fichier vide (cassé)</small>
                ) : (
                  <small>{formatBytes(item.sizeBytes)}</small>
                )}
              </span>
            </div>
          </td>
          <td>
            <span className="admin-inv-type">
              {item.mediaKind === 'video' ? (
                <Film size={14} />
              ) : (
                <ImageIcon size={14} />
              )}
              {item.mediaKind === 'video' ? 'Vidéo' : 'Image'}
            </span>
          </td>
          <td>
            <span
              className={`admin-pill ${
                item.exempt ? 'neutral' : item.scanned ? 'ok' : 'warn'
              }`}
            >
              {item.exempt ? 'Exempté' : item.scanned ? 'Vérifié' : 'Non vérifié'}
            </span>
          </td>
          <td>
            <span className={`admin-pill ${ai.cls}`}>
              {ai.label}
              {item.aiStatus === 'flagged' && item.aiCategory
                ? ` · ${item.aiCategory} ${Math.round((item.aiScore ?? 0) * 100)}%`
                : ''}
            </span>
          </td>
          <td>
            <span className={`admin-pill ${adm.cls}`}>{adm.label}</span>
          </td>
        </tr>
      )
    }
    return (
      <section className="admin-mediamod-inventory" aria-label="Tous les médias">
        <div className="admin-mediamod-invhead">
          <span className="admin-inv-count">{total} média(s)</span>
          <div className="admin-inv-tools">
            <button type="button" className="admin-inv-collapseall" onClick={collapseAll}>
              Tout replier
            </button>
            <button
              type="button"
              className="admin-inv-collapseall"
              onClick={() => setCollapsedGroups(new Set())}
            >
              Tout déplier
            </button>
            <label className="admin-inv-sort">
              Trier par
              <select
                value={inventorySort}
                onChange={(event) =>
                  setInventorySort(event.target.value as 'user' | 'map')
                }
              >
                <option value="user">Utilisateur</option>
                <option value="map">Carte</option>
              </select>
            </label>
          </div>
        </div>
        {total === 0 ? (
          <p className="admin-empty">
            Aucun média.
            {mediaMod?.usage ? '' : ' La modération IA n’a pas encore tourné.'}
          </p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Média</th>
                  <th>Type</th>
                  <th>Vérification</th>
                  <th>Décision IA</th>
                  <th>Décision admin</th>
                </tr>
              </thead>
              <tbody>
                {inventoryTree.map((group) => {
                  const groupKey = `g:${group.label}`
                  const groupCollapsed = collapsedGroups.has(groupKey)
                  return (
                    <Fragment key={groupKey}>
                      <tr className="admin-inv-group admin-inv-l1">
                        <td colSpan={5}>
                          <button
                            type="button"
                            className="admin-inv-toggle"
                            onClick={() => toggleGroup(groupKey)}
                          >
                            {groupCollapsed ? (
                              <ChevronRight size={16} />
                            ) : (
                              <ChevronDown size={16} />
                            )}
                            {group.label}
                            <span className="admin-inv-grpcount">{group.count}</span>
                          </button>
                        </td>
                      </tr>
                      {groupCollapsed
                        ? null
                        : group.subs.map((sub) => {
                            const subKey = `s:${group.label}»${sub.label}`
                            const subCollapsed = collapsedGroups.has(subKey)
                            return (
                              <Fragment key={subKey}>
                                <tr className="admin-inv-group admin-inv-l2">
                                  <td colSpan={5}>
                                    <button
                                      type="button"
                                      className="admin-inv-toggle sub"
                                      onClick={() => toggleGroup(subKey)}
                                    >
                                      {subCollapsed ? (
                                        <ChevronRight size={15} />
                                      ) : (
                                        <ChevronDown size={15} />
                                      )}
                                      {sub.label}
                                      <span className="admin-inv-grpcount">
                                        {sub.items.length}
                                      </span>
                                    </button>
                                  </td>
                                </tr>
                                {subCollapsed ? null : sub.items.map(mediaRow)}
                              </Fragment>
                            )
                          })}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    )
  })()

  const mediaModerationView = (() => {
    const usage = mediaMod?.usage
    const dailyLimit = mediaMod?.dailyLimit ?? 500
    const monthlyLimit = mediaMod?.monthlyLimit ?? 2000
    return (
      <>
        <section className="admin-stats" aria-label="Synthèse modération IA">
          <article className="admin-stat-card featured">
            <span><ShieldAlert size={18} /></span>
            <p>En attente de revue</p>
            <strong>{mediaReviewGroups.length}</strong>
          </article>
          <article className="admin-stat-card">
            <span><ScanLine size={18} /></span>
            <p>Opérations aujourd’hui</p>
            <strong>{usage?.dayOps ?? 0}</strong>
            <small>sur {dailyLimit} (palier gratuit)</small>
          </article>
          <article className="admin-stat-card">
            <span><ScanLine size={18} /></span>
            <p>Opérations ce mois</p>
            <strong>{usage?.monthOps ?? 0}</strong>
            <small>sur {monthlyLimit} (palier gratuit)</small>
          </article>
        </section>

        <div className="admin-mediamod-toolbar">
          <button
            className="admin-refresh"
            type="button"
            disabled={busyAction === 'scan-media'}
            onClick={() => void scanMedia()}
          >
            <ScanLine size={16} /> Lancer un scan
          </button>
          {scanInfo ? <span className="admin-mediamod-scaninfo">{scanInfo}</span> : null}
        </div>

        {mediaReviewGroups.length > 0 ? (
          <div className="admin-mediamod-grid">
            {mediaReviewGroups.map((group) => (
              <article className="admin-mediamod-card" key={group.id}>
                <div className="admin-mediamod-preview">
                  {group.original.mediaKind === 'video' ? (
                    <video
                      src={group.original.mediaUrl}
                      controls
                      preload="metadata"
                      crossOrigin="use-credentials"
                    />
                  ) : (
                    <img
                      src={group.original.mediaUrl}
                      alt="Média signalé"
                      crossOrigin="use-credentials"
                    />
                  )}
                  {group.thumbnail ? (
                    <div className="admin-mediamod-thumb">
                      {renderReviewAsset(group.thumbnail, 'Vignette signalee')}
                      <span>Vignette</span>
                    </div>
                  ) : null}
                  <span className="admin-mediamod-score">
                    {group.scoreItem.aiCategory} · {Math.round(group.scoreItem.aiScore * 100)}%
                  </span>
                </div>
                <div className="admin-mediamod-info">
                  <strong>{group.primary.mapTitle}</strong>
                  <small>{group.primary.ownerEmail ?? group.primary.ownerUid}</small>
                  <small>{group.label} · {group.ids.length} signalement(s)</small>
                  <small>Scanné le {formatDateTime(group.scoreItem.scannedAt)}</small>
                </div>
                <div className="admin-actions">
                  <button
                    className="admin-action success"
                    type="button"
                    disabled={busyAction === `media-${group.id}`}
                    onClick={() => void approveMedia(group)}
                    title="L’IA s’est trompée : rétablir le média"
                  >
                    <Check size={15} /> Approuver
                  </button>
                  <button
                    className="admin-action danger"
                    type="button"
                    disabled={busyAction === `media-${group.id}`}
                    onClick={() => {
                      setRejectMediaMessage('')
                      setRejectMediaTarget(group)
                    }}
                    title="Non conforme : supprimer le média"
                  >
                    <Trash2 size={15} /> Rejeter
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="admin-empty">
            Aucun média en attente de revue.
            {usage ? '' : ' La modération IA n’a pas encore tourné.'}
          </p>
        )}

        <section className="admin-mediamod-history">
          <div className="admin-mediamod-history-head">
            <div>
              <p className="admin-kicker"><LineChart size={13} /> Historique IA</p>
              <h2>Décisions de modération</h2>
            </div>
            <div className="admin-mediamod-range">
              <button type="button" onClick={() => setMediaHistoryPreset(7)}>
                7 jours
              </button>
              <button type="button" onClick={() => setMediaHistoryPreset(30)}>
                30 jours
              </button>
              <button type="button" onClick={() => setMediaHistoryPreset(90)}>
                90 jours
              </button>
              <button type="button" onClick={() => setMediaHistoryPreset('all')}>
                Tout
              </button>
              <label>
                Du
                <input
                  type="date"
                  value={mediaHistoryFrom}
                  onChange={(event) => setMediaHistoryFrom(event.target.value)}
                />
              </label>
              <label>
                Au
                <input
                  type="date"
                  value={mediaHistoryTo}
                  onChange={(event) => setMediaHistoryTo(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="admin-mediamod-history-stats">
            <article>
              <span><Check size={16} /></span>
              <p>Validations</p>
              <strong>{mediaHistoryStats.approvedCount}</strong>
            </article>
            <article>
              <span><Trash2 size={16} /></span>
              <p>Suppressions</p>
              <strong>{mediaHistoryStats.rejectedCount}</strong>
            </article>
            <article>
              <span><ScanLine size={16} /></span>
              <p>Suppressions auto</p>
              <strong>{mediaHistoryStats.autoRejectedCount}</strong>
            </article>
          </div>

          <div className="admin-mediamod-chart">
            <div className="admin-mediamod-chart-title">
              <strong>Suppressions par jour</strong>
              <small>{mediaHistoryStats.filtered.length} décision(s) dans la période</small>
            </div>
            {mediaHistoryStats.days.length > 0 ? (
              <div className="admin-mediamod-bars" role="img" aria-label="Suppressions par jour">
                {mediaHistoryStats.days.map((day) => {
                  const height = day.rejected
                    ? Math.max(8, (day.rejected / mediaHistoryStats.maxRejected) * 100)
                    : 0
                  return (
                    <div
                      className="admin-mediamod-bar-col"
                      key={day.day}
                      title={`${formatDayLabel(day.day)} : ${day.rejected} suppression(s), ${day.approved} validation(s)`}
                    >
                      <span style={{ height: `${height}%` }} />
                      <small>{formatDayLabel(day.day)}</small>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="admin-empty compact">Aucune décision sur cette période.</p>
            )}
          </div>

          {mediaHistoryStats.filtered.length > 0 ? (
            <div className="admin-table-wrap admin-mediamod-history-table">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Décision</th>
                    <th>Date</th>
                    <th>Carte</th>
                    <th>Propriétaire</th>
                    <th>IA</th>
                    <th>Médias</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {mediaHistoryStats.filtered.slice(0, 80).map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <span
                          className={`admin-pill ${
                            entry.decision === 'approved' ? 'ok' : 'danger'
                          }`}
                        >
                          {entry.decision === 'approved' ? 'Validation' : 'Suppression'}
                        </span>
                      </td>
                      <td>{formatDateTime(entry.decidedAt)}</td>
                      <td>
                        <span className="admin-cell-stack">
                          <strong>{entry.mapTitle}</strong>
                          <small>{entry.mapCode}</small>
                        </span>
                      </td>
                      <td>{entry.ownerEmail ?? entry.ownerUid}</td>
                      <td>
                        {entry.aiCategory || 'Signalement'} · {Math.round(entry.aiScore * 100)}%
                      </td>
                      <td>{entry.mediaIds.length}</td>
                      <td>{entry.source === 'auto' ? 'Auto' : entry.decidedByEmail ?? entry.decidedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mediaHistoryStats.filtered.length > 80 ? (
                <p className="admin-mediamod-history-note">
                  {mediaHistoryStats.filtered.length - 80} décision(s) plus ancienne(s) masquée(s).
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      </>
    )
  })()

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
            <button
              className={`admin-topbar-bell${section === 'notifications' ? ' active' : ''}`}
              type="button"
              title="Notifications"
              aria-label="Notifications"
              onClick={() => setSection('notifications')}
            >
              <Bell size={18} />
              {unreadCount > 0 ? (
                <span className="admin-topbar-bell-badge">{unreadCount}</span>
              ) : null}
            </button>
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
              {emailPanel}
              {revenuePanel}
              {growthPanel}
            </>
          ) : section === 'costs' ? (
            costsView
          ) : section === 'users' ? (
            usersTable
          ) : section === 'maps' ? (
            mapsTable
          ) : section === 'sanctions' ? (
            sanctionsView
          ) : section === 'media-moderation' ? (
            mediaModerationView
          ) : section === 'media-inventory' ? (
            inventoryTable
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

      {rejectMediaTarget ? (
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
          <div className="admin-modal">
            <h2 className="admin-modal-danger">
              <Trash2 size={18} /> Rejeter ce média
            </h2>
            <p>
              Action <strong>définitive</strong>. Le média (et sa vignette) sera
              supprimé de la carte « {rejectMediaTarget.primary.mapTitle} » et de Cloudflare
              R2. Le propriétaire
              ({rejectMediaTarget.primary.ownerEmail ?? rejectMediaTarget.primary.ownerUid}) sera
              notifié avec le message ci-dessous.
            </p>
            <label className="admin-modal-label" htmlFor="reject-media-message">
              Message au propriétaire (facultatif, affiché à sa prochaine connexion)
            </label>
            <textarea
              autoFocus
              className="admin-modal-textarea"
              id="reject-media-message"
              placeholder="Ex : Un de vos médias a été retiré car il ne respecte pas…"
              value={rejectMediaMessage}
              onChange={(event) => setRejectMediaMessage(event.target.value)}
            />
            <div className="admin-modal-actions">
              <button
                className="admin-modal-cancel"
                type="button"
                onClick={() => setRejectMediaTarget(null)}
              >
                Annuler
              </button>
              <button
                className="admin-modal-delete"
                disabled={busyAction === `media-${rejectMediaTarget.id}`}
                type="button"
                onClick={async () => {
                  const target = rejectMediaTarget
                  await rejectMedia(target, rejectMediaMessage.trim())
                  setRejectMediaTarget(null)
                }}
              >
                <Trash2 size={15} /> Rejeter le média
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
