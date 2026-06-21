import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import {
  ArrowRight,
  BarChart3,
  Ban,
  Bell,
  Camera,
  Check,
  ChevronRight,
  CircleUserRound,
  Compass,
  Eye,
  EyeOff,
  FolderKanban,
  Gauge,
  HardDrive,
  Image,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  MailCheck,
  Map,
  Menu,
  Monitor,
  Moon,
  Mountain,
  Pencil,
  Plus,
  Route,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Wallet,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  type User,
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updatePassword,
  updateProfile,
} from 'firebase/auth'
import {
  type AccountStatus,
  type PortalHike,
  type PortalNotification,
  type PortalUser,
  type ProfileExtras,
} from './portalStore'
import {
  finalizeAccountDeletion,
  getFirebaseAuth,
  getIdToken,
  googleProvider,
  markUserNotificationsRead,
  readAccountStatus,
  readUserNotifications,
  readUserProfile,
  requestAccountDeletion,
  saveTermsAcceptance,
  saveUserPhoto,
  saveUserPlan,
  saveUserProfile,
  sendAccountAppeal,
} from './firebase'
import {
  DEFAULT_PLAN_ID,
  PLANS,
  planById,
  formatBytes,
  type PlanId,
} from './plans'
import { AdminApp } from './admin/AdminView'
import { requestMediaTicket, startMediaTicketRefresh } from '../lib/mediaTicket'
import HeroSlideshow from './HeroSlideshow'
import { TraceRecorderScreen, TracesView } from './TraceViews'
import { hasLocalTraceDraft } from './userTraces'
import {
  getThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../lib/theme'
import './Portal.css'

type PortalView =
  | 'dashboard'
  | 'hikes'
  | 'profile'
  | 'plans'
  | 'notifications'
  | 'admin'
  | 'settings'
  | 'traces'
  | 'tracker'
  | 'terms'

// Entrée du registre serveur (api/hikes), source de vérité du dashboard.
type BackendHike = {
  code: string
  ownerId: string
  title: string
  status: 'published' | 'draft'
  distanceKm: number
  elevationGain: number
  pointCount: number
  mediaCount: number
  coverUrl?: string
  updatedAt: string
}

const backendHikes = (
  backend: BackendHike[],
  ownerId: string,
): PortalHike[] => {
  return backend
    .map((entry) => ({
      id: entry.code,
      ownerId: entry.ownerId || ownerId,
      title: entry.title || entry.code,
      code: entry.code,
      status: entry.status,
      distanceKm: entry.distanceKm,
      elevationGain: entry.elevationGain,
      mediaCount: entry.mediaCount,
      pointCount: entry.pointCount,
      updatedAt: entry.updatedAt,
      coverUrl: entry.coverUrl,
    }))
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
}

const navigate = (path: string): void => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// Demande l'envoi du mail de vérification : on tente d'abord le mail personnalisé
// Relieo (via /api/account, envoyé par notre fournisseur), avec repli automatique
// sur l'envoi natif Firebase si le fournisseur n'est pas configuré ou échoue.
async function requestEmailVerification(user: User): Promise<void> {
  try {
    const token = await user.getIdToken()
    const response = await fetch('/api/account', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: 'send-verification' }),
    })
    const data = (await response.json().catch(() => null)) as
      | { sent?: boolean; fallback?: boolean; alreadyVerified?: boolean }
      | null
    if (response.ok && (data?.sent || data?.alreadyVerified)) return
  } catch {
    // Erreur réseau : on bascule sur le repli Firebase ci-dessous.
  }
  await sendEmailVerification(user)
}

const currentView = (): PortalView => {
  // Page CGU : publique et prioritaire (lisible connecté comme déconnecté, et
  // jamais détournée par le brouillon de trace local).
  if (window.location.pathname.endsWith('/terms')) return 'terms'
  if (window.location.pathname === '/tracker') return 'tracker'
  if (hasLocalTraceDraft()) return 'tracker'
  if (window.location.pathname.endsWith('/profile')) return 'profile'
  if (window.location.pathname.endsWith('/hikes')) return 'hikes'
  if (window.location.pathname.endsWith('/plans')) return 'plans'
  if (window.location.pathname.endsWith('/traces')) return 'traces'
  if (window.location.pathname.endsWith('/notifications')) return 'notifications'
  if (window.location.pathname.endsWith('/settings')) return 'settings'
  if (window.location.pathname.endsWith('/admin')) return 'admin'
  return 'dashboard'
}

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))

// Titre court d'une notification utilisateur selon son type.
const notifTitle = (item: PortalNotification): string => {
  if (item.type === 'block') return 'Compte bloqué'
  if (item.type === 'delete-account') return 'Compte supprimé'
  if (item.type === 'media-rejected') {
    return item.mapTitle ? `Média retiré de « ${item.mapTitle} »` : 'Média retiré'
  }
  if (item.mapTitle && item.type !== 'info') {
    return `Carte « ${item.mapTitle} » ${
      item.type === 'delete' ? 'supprimée' : 'dépubliée'
    }`
  }
  return 'Notification'
}

// Types de notifications affichés en plein écran à l'arrivée (popup), en plus
// du centre de notifications. Liste volontairement explicite : ajouter ici les
// futurs types à mettre en avant.
const POPUP_NOTIF_TYPES: ReadonlyArray<PortalNotification['type']> = [
  'block',
  'delete-account',
  'unpublish',
  'delete',
  'media-rejected',
]

const ADMIN_PHONE_NOTICE =
  'Console admin indisponible sur téléphone. Connecte-toi depuis un ordinateur pour gérer Relieo.'
const AUTH_NOTICE_STORAGE_KEY = 'relieo.auth.notice'

const isAdminPhoneDevice = (): boolean => {
  const touchLike =
    window.matchMedia('(pointer: coarse)').matches ||
    navigator.maxTouchPoints > 0
  const shortestScreenSide = Math.min(window.screen.width, window.screen.height)

  return touchLike && shortestScreenSide <= 640
}

// Icône + teinte (classe CSS) d'une notification selon son type.
const notifVisual = (type: PortalNotification['type']) => {
  switch (type) {
    case 'block':
      return { icon: <Ban size={18} />, tone: 'danger' }
    case 'delete-account':
    case 'delete':
      return { icon: <Trash2 size={18} />, tone: 'danger' }
    case 'media-rejected':
      return { icon: <ShieldAlert size={18} />, tone: 'danger' }
    case 'unpublish':
      return { icon: <EyeOff size={18} />, tone: 'warn' }
    default:
      return { icon: <Bell size={18} />, tone: 'info' }
  }
}

const userInitials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'R3'

// Style d'avatar : photo en fond si disponible, sinon initiales colorées.
const avatarStyle = (photoURL?: string): CSSProperties | undefined =>
  photoURL
    ? {
        backgroundImage: `url(${photoURL})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        color: 'transparent',
      }
    : undefined

// Modale de recadrage de la photo de profil : on déplace (glisser) et on zoome
// (curseur) l'image dans un cadre circulaire, puis « Valider » génère la
// vignette 256px recadrée exactement comme à l'écran et l'enregistre direct.
const CROP_VIEW = 264 // taille du cadre à l'écran (px)
const CROP_OUT = 256 // taille de la vignette générée (px)

function AvatarCropDialog({
  file,
  onCancel,
  onValidate,
}: {
  file: File
  onCancel: () => void
  onValidate: (photoURL: string) => void
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [error, setError] = useState<string | null>(null)
  const dragRef = useRef<
    { px: number; py: number; ox: number; oy: number } | null
  >(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    const img = new window.Image()
    img.onload = () => {
      setImage(img)
      setZoom(1)
      setOffset({ x: 0, y: 0 })
    }
    img.onerror = () => setError('Image illisible.')
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  const baseScale = image
    ? Math.max(CROP_VIEW / image.naturalWidth, CROP_VIEW / image.naturalHeight)
    : 1
  const scale = baseScale * zoom
  const drawW = image ? image.naturalWidth * scale : 0
  const drawH = image ? image.naturalHeight * scale : 0
  const maxOffsetX = Math.max((drawW - CROP_VIEW) / 2, 0)
  const maxOffsetY = Math.max((drawH - CROP_VIEW) / 2, 0)
  const clamp = (value: number, max: number): number =>
    Math.min(max, Math.max(-max, value))
  const posX = (CROP_VIEW - drawW) / 2 + clamp(offset.x, maxOffsetX)
  const posY = (CROP_VIEW - drawH) / 2 + clamp(offset.y, maxOffsetY)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      px: event.clientX,
      py: event.clientY,
      ox: clamp(offset.x, maxOffsetX),
      oy: clamp(offset.y, maxOffsetY),
    }
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    setOffset({
      x: clamp(dragRef.current.ox + (event.clientX - dragRef.current.px), maxOffsetX),
      y: clamp(dragRef.current.oy + (event.clientY - dragRef.current.py), maxOffsetY),
    })
  }
  const endDrag = () => {
    dragRef.current = null
  }

  const validate = () => {
    if (!image) return
    const canvas = document.createElement('canvas')
    canvas.width = CROP_OUT
    canvas.height = CROP_OUT
    const context = canvas.getContext('2d')
    if (!context) {
      setError('Canvas indisponible.')
      return
    }
    const ratio = CROP_OUT / CROP_VIEW
    context.drawImage(
      image,
      posX * ratio,
      posY * ratio,
      drawW * ratio,
      drawH * ratio,
    )
    onValidate(canvas.toDataURL('image/jpeg', 0.85))
  }

  return (
    <div className="portal-modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        aria-labelledby="crop-title"
        aria-modal="true"
        className="portal-modal avatar-crop-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button aria-label="Fermer" className="icon-button modal-close" type="button" onClick={onCancel}><X size={18} /></button>
        <span className="modal-icon"><Camera size={22} /></span>
        <h2 id="crop-title">Cadrer la photo</h2>
        <p>Glissez pour déplacer, utilisez le curseur pour zoomer.</p>
        <div
          className="avatar-crop-stage"
          style={{ width: CROP_VIEW, height: CROP_VIEW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {image ? (
            <img
              alt=""
              className="avatar-crop-image"
              draggable={false}
              src={image.src}
              style={{ left: posX, top: posY, width: drawW, height: drawH }}
            />
          ) : null}
        </div>
        <label className="avatar-crop-zoom">
          <ZoomOut size={17} />
          <input
            max={4}
            min={1}
            step={0.01}
            type="range"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
          <ZoomIn size={17} />
        </label>
        {error ? <p className="auth-error">{error}</p> : null}
        <button className="portal-primary" disabled={!image} type="button" onClick={validate}>
          <Check size={17} /> Valider la photo
        </button>
      </section>
    </div>
  )
}

function CreateHikeDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (title: string, code: string) => void
}) {
  const [title, setTitle] = useState('')
  const [code, setCode] = useState('')

  return (
    <div className="portal-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-labelledby="create-hike-title"
        aria-modal="true"
        className="portal-modal"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button aria-label="Fermer" className="icon-button modal-close" type="button" onClick={onClose}><X size={18} /></button>
        <span className="modal-icon"><Mountain size={22} /></span>
        <h2 id="create-hike-title">Nouvelle carte</h2>
        <p>Un Studio 3D vierge sera préparé avec ce code.</p>
        <label>
          <span>Nom de la carte</span>
          <input autoFocus placeholder="Tour du Mont Blanc" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>Code unique</span>
          <input placeholder="TMB-2026" value={code} onChange={(event) => setCode(event.target.value)} />
        </label>
        <button
          className="portal-primary"
          disabled={!title.trim() || !code.trim()}
          type="button"
          onClick={() => onCreate(title.trim(), code.trim())}
        >
          <Plus size={17} /> Créer la carte
        </button>
      </section>
    </div>
  )
}

function HikeCard({
  hike,
  busy,
  onToggleStatus,
}: {
  hike: PortalHike
  busy: boolean
  onToggleStatus: (hike: PortalHike) => void
}) {
  // Publiée → ouvre le Studio sur la rando déjà en ligne (chargée depuis Vercel).
  //   `code` identifie laquelle (ignoré tant que le backend reste mono-rando).
  // Brouillon → ouvre un Studio 3D vierge en local (`new`).
  const title = `&title=${encodeURIComponent(hike.title)}`
  // Publiée ou brouillon : on ouvre la carte par son code (le Studio recharge le
  // contenu sauvegardé ; un brouillon n'est servi qu'à son propriétaire/admin).
  const openHref = `/?mode=studio&code=${encodeURIComponent(hike.code)}${title}`
  return (
    <article className="hike-card">
      <div
        className={hike.coverUrl ? 'hike-cover' : 'hike-cover hike-cover-empty'}
        style={hike.coverUrl ? { backgroundImage: `url(${hike.coverUrl})` } : undefined}
      >
        <span className={`status-pill ${hike.status}`}>
          {hike.status === 'published' ? <Check size={13} /> : <Pencil size={13} />}
          {hike.status === 'published' ? 'Publiée' : 'Brouillon'}
        </span>
        {!hike.coverUrl ? <Mountain size={40} /> : null}
      </div>
      <div className="hike-card-body">
        <div>
          <p className="hike-code">{hike.code}</p>
          <h3>{hike.title}</h3>
        </div>
        <dl className="hike-metrics">
          <div><dt>Distance</dt><dd>{hike.distanceKm.toLocaleString('fr-FR')} km</dd></div>
          <div><dt>D+</dt><dd>{hike.elevationGain.toLocaleString('fr-FR')} m</dd></div>
          <div><dt>Médias</dt><dd>{hike.mediaCount}</dd></div>
        </dl>
        <div className="hike-card-footer">
          <span>Modifiée le {formatDate(hike.updatedAt)}</span>
          <div className="hike-card-actions">
            <button
              className="hike-toggle"
              disabled={busy}
              type="button"
              onClick={() => onToggleStatus(hike)}
              title={
                hike.status === 'published'
                  ? 'Retirer du public (passe en brouillon)'
                  : 'Remettre en ligne'
              }
            >
              {hike.status === 'published' ? (
                <><EyeOff size={15} /> Dépublier</>
              ) : (
                <><Check size={15} /> Publier</>
              )}
            </button>
            <a className="hike-open" href={openHref}>Ouvrir <ChevronRight size={16} /></a>
          </div>
        </div>
      </div>
    </article>
  )
}

function ProfileView({
  user,
  onSave,
  onSavePhoto,
  canChangePassword,
  onChangePassword,
}: {
  user: PortalUser
  onSave: (user: PortalUser) => Promise<void>
  onSavePhoto: (photoURL: string) => Promise<void>
  canChangePassword: boolean
  onChangePassword: (current: string, next: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(user)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [pwdBusy, setPwdBusy] = useState(false)
  const [pwdSaved, setPwdSaved] = useState(false)
  const [pwdError, setPwdError] = useState<string | null>(null)
  const pwdChecks = passwordChecks(newPassword)
  const pwdStrong = pwdChecks.every((check) => check.valid)
  const pwdMatch = newPassword === confirmPassword
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteReason, setDeleteReason] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletionRequested, setDeletionRequested] = useState(false)

  // Une demande de suppression est-elle déjà en attente ? (état initial)
  useEffect(() => {
    let cancelled = false
    void readAccountStatus(user.id)
      .then((status) => {
        if (!cancelled) setDeletionRequested(status.deletionRequested)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [user.id])

  const submitDeletion = async () => {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await requestAccountDeletion(deleteReason.trim())
      setDeleteOpen(false)
      setDeletionRequested(true)
    } catch (requestError) {
      setDeleteError(
        requestError instanceof Error
          ? requestError.message
          : 'Envoi de la demande impossible.',
      )
    } finally {
      setDeleteBusy(false)
    }
  }

  const pickPhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setSaved(false)
    setCropFile(file)
  }

  // Validation du recadrage : enregistre la photo immédiatement (pas besoin du
  // bouton « Enregistrer le profil »).
  const applyPhoto = async (photoURL: string) => {
    setCropFile(null)
    setPhotoBusy(true)
    setError(null)
    try {
      await onSavePhoto(photoURL)
      setDraft((current) => ({ ...current, photoURL }))
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'Enregistrement de la photo impossible.',
      )
    } finally {
      setPhotoBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      await onSave(draft)
      setSaved(true)
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'Enregistrement du profil impossible.',
      )
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!pwdStrong) {
      setPwdError('Le nouveau mot de passe ne respecte pas tous les critères.')
      return
    }
    if (!pwdMatch) {
      setPwdError('Les deux nouveaux mots de passe ne correspondent pas.')
      return
    }
    setPwdBusy(true)
    setPwdError(null)
    setPwdSaved(false)
    try {
      await onChangePassword(currentPassword, newPassword)
      setPwdSaved(true)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (changeError) {
      const code = (changeError as { code?: string }).code
      if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
        setPwdError('Le mot de passe actuel est incorrect.')
      } else if (code === 'auth/requires-recent-login') {
        setPwdError('Reconnecte-toi puis réessaie (session trop ancienne).')
      } else {
        setPwdError(firebaseErrorMessage(changeError))
      }
    } finally {
      setPwdBusy(false)
    }
  }

  return (
    <section className="profile-view">
      <header className="page-heading">
        <div><p className="portal-kicker">Compte</p><h1>Votre profil</h1><p>Les informations qui accompagneront vos cartes.</p></div>
      </header>
      <div className="profile-layout">
        <div className="profile-identity">
          <div className="profile-avatar-edit">
            <span className="profile-avatar large" style={avatarStyle(draft.photoURL)}>
              {draft.photoURL ? '' : userInitials(draft.name)}
            </span>
            <button
              aria-label="Modifier la photo de profil"
              className="avatar-edit-button"
              disabled={photoBusy}
              title="Modifier la photo de profil"
              type="button"
              onClick={() => photoInputRef.current?.click()}
            >
              <Pencil size={17} />
            </button>
            <input
              accept="image/*"
              hidden
              ref={photoInputRef}
              type="file"
              onChange={pickPhoto}
            />
          </div>
          {cropFile ? (
            <AvatarCropDialog
              file={cropFile}
              onCancel={() => setCropFile(null)}
              onValidate={applyPhoto}
            />
          ) : null}
          <h2>{draft.name}</h2><p>{draft.email}</p>
          <span className="profile-security"><ShieldCheck size={15} /> Profil Firestore protégé</span>
        </div>
        <form className="profile-form" onSubmit={submit}>
          <label><span>Nom complet</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>Email Firebase</span><input readOnly type="email" value={draft.email} /></label>
          <label><span>Localisation</span><input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
          <label className="profile-bio"><span>Présentation</span><textarea rows={4} value={draft.bio} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></label>
          {error ? <p className="auth-error">{error}</p> : null}
          <button className="portal-primary" disabled={busy} type="submit">{saved ? <Check size={17} /> : <UserRound size={17} />}{busy ? 'Enregistrement...' : saved ? 'Profil enregistré' : 'Enregistrer le profil'}</button>
        </form>
      </div>

      {canChangePassword ? (
        <div className="profile-password">
          <div className="profile-password-text">
            <h3>Mot de passe</h3>
            <p>Modifie le mot de passe de connexion de ton compte.</p>
          </div>
          <form className="profile-password-form" onSubmit={submitPassword}>
            <label>
              <span>Mot de passe actuel</span>
              <div className="input-shell">
                <KeyRound size={17} />
                <input
                  autoComplete="current-password"
                  required
                  type={showPwd ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
                <button
                  aria-label={showPwd ? 'Masquer les mots de passe' : 'Afficher les mots de passe'}
                  className="password-visibility"
                  type="button"
                  onClick={() => setShowPwd((visible) => !visible)}
                >
                  {showPwd ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            <label>
              <span>Nouveau mot de passe</span>
              <div className="input-shell">
                <KeyRound size={17} />
                <input
                  autoComplete="new-password"
                  minLength={12}
                  required
                  type={showPwd ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
            </label>
            {newPassword ? (
              <ul className="password-rules" aria-label="Règles du mot de passe">
                {pwdChecks.map((check) => (
                  <li className={check.valid ? 'valid' : ''} key={check.label}>
                    <Check aria-hidden="true" size={13} />
                    {check.label}
                  </li>
                ))}
              </ul>
            ) : null}
            <label>
              <span>Confirmer le nouveau mot de passe</span>
              <div className="input-shell">
                <KeyRound size={17} />
                <input
                  autoComplete="new-password"
                  minLength={12}
                  required
                  type={showPwd ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
              {confirmPassword ? (
                <small className={pwdMatch ? 'password-match valid' : 'password-match'}>
                  {pwdMatch
                    ? 'Les mots de passe correspondent.'
                    : 'Les mots de passe ne correspondent pas.'}
                </small>
              ) : null}
            </label>
            {pwdError ? <p className="auth-error">{pwdError}</p> : null}
            <button className="portal-primary" disabled={pwdBusy} type="submit">
              {pwdSaved ? <Check size={17} /> : <KeyRound size={17} />}
              {pwdBusy
                ? 'Modification...'
                : pwdSaved
                  ? 'Mot de passe modifié'
                  : 'Modifier le mot de passe'}
            </button>
          </form>
        </div>
      ) : null}

      <div className="profile-danger">
        <div className="profile-danger-text">
          <h3>Supprimer mon compte</h3>
          <p>
            Ta demande sera transmise à l’administrateur, qui supprimera ton
            compte et tout son contenu. Cette action est irréversible.
          </p>
        </div>
        {deletionRequested ? (
          <p className="profile-danger-pending">
            <Trash2 size={15} /> Demande envoyée, en attente de traitement par
            l’administrateur.
          </p>
        ) : (
          <button
            className="profile-danger-button"
            type="button"
            onClick={() => {
              setDeleteReason('')
              setDeleteConfirm('')
              setDeleteError(null)
              setDeleteOpen(true)
            }}
          >
            <Trash2 size={16} /> Supprimer mon profil
          </button>
        )}
      </div>

      {deleteOpen ? (
        <div className="portal-modal-backdrop" role="dialog" aria-modal="true">
          <div className="portal-modal">
            <h2>Supprimer mon profil</h2>
            <p>
              Explique pourquoi tu souhaites supprimer ton compte. La demande
              sera envoyée à l’administrateur.
            </p>
            <textarea
              rows={4}
              value={deleteReason}
              placeholder="Raison de la suppression"
              onChange={(event) => setDeleteReason(event.target.value)}
            />
            <label className="profile-danger-confirm">
              <span>
                Tape <strong>delete</strong> pour confirmer
              </span>
              <input
                type="text"
                autoComplete="off"
                value={deleteConfirm}
                placeholder="delete"
                onChange={(event) => setDeleteConfirm(event.target.value)}
              />
            </label>
            {deleteError ? <p className="auth-error">{deleteError}</p> : null}
            <div className="portal-modal-actions">
              <button
                className="portal-secondary"
                type="button"
                disabled={deleteBusy}
                onClick={() => setDeleteOpen(false)}
              >
                Annuler
              </button>
              <button
                className="profile-danger-button"
                type="button"
                disabled={
                  deleteBusy ||
                  !deleteReason.trim() ||
                  deleteConfirm.trim().toLowerCase() !== 'delete'
                }
                onClick={() => void submitDeletion()}
              >
                {deleteBusy ? 'Envoi...' : 'Envoyer la demande'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function SettingsView() {
  const [pref, setPref] = useState<ThemePreference>(() => getThemePreference())

  const choose = (next: ThemePreference) => {
    setPref(next)
    setThemePreference(next)
  }

  const options: {
    id: ThemePreference
    label: string
    desc: string
    icon: ReactNode
  }[] = [
    { id: 'light', label: 'Clair', desc: 'Thème lumineux', icon: <Sun size={22} /> },
    { id: 'dark', label: 'Nuit', desc: 'Thème sombre', icon: <Moon size={22} /> },
    {
      id: 'auto',
      label: 'Auto',
      desc: 'Selon votre appareil',
      icon: <Monitor size={22} />,
    },
  ]

  return (
    <section className="settings-view">
      <header className="page-heading">
        <div>
          <p className="portal-kicker">Paramètres</p>
          <h1>Apparence</h1>
          <p>Choisissez le thème de votre espace.</p>
        </div>
      </header>
      <div className="theme-options">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`theme-option${pref === option.id ? ' is-active' : ''}`}
            onClick={() => choose(option.id)}
          >
            <span className="theme-option-icon">{option.icon}</span>
            <strong>{option.label}</strong>
            <small>{option.desc}</small>
            {pref === option.id ? (
              <span className="theme-option-check">
                <Check size={15} />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="settings-legal">
        <button type="button" onClick={() => navigate('/terms')}>
          <ShieldCheck size={16} /> Conditions d’utilisation &amp; confidentialité
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  )
}

type StorageUsage = { usedBytes: number; limitBytes: number }

// Grille des cartes de forfait, partagée par l'onboarding (post-inscription) et
// l'onglet « Forfait ». `currentPlanId` marque le forfait actif ; `onChoose`
// n'est branché que sur les forfaits réellement disponibles.
function PlanCards({
  currentPlanId,
  onChoose,
  choosing,
}: {
  currentPlanId?: string
  onChoose?: (planId: PlanId) => void
  choosing?: PlanId | null
}) {
  return (
    <div className="plan-grid">
      {PLANS.map((plan) => {
        const isCurrent = plan.id === currentPlanId
        const busy = choosing === plan.id
        return (
          <article
            className={`plan-card${plan.highlight ? ' featured' : ''}${isCurrent ? ' current' : ''}`}
            key={plan.id}
          >
            {plan.highlight ? (
              <span className="plan-badge"><Sparkles size={13} /> Recommandé</span>
            ) : null}
            <header className="plan-card-head">
              <h3>{plan.name}</h3>
              <p>{plan.tagline}</p>
            </header>
            <p className="plan-price">
              <strong>{plan.priceLabel}</strong>
              <span>{plan.priceSuffix}</span>
            </p>
            <p className="plan-storage"><HardDrive size={15} /> {plan.storageLabel}</p>
            <ul className="plan-features">
              {plan.features.map((feature) => (
                <li key={feature}><Check size={14} /> {feature}</li>
              ))}
            </ul>
            {isCurrent ? (
              <button className="plan-cta current" disabled type="button">
                <Check size={16} /> Plan actuel
              </button>
            ) : !plan.available ? (
              <button className="plan-cta soon" disabled type="button">
                <Lock size={15} /> Bientôt disponible
              </button>
            ) : (
              <button
                className="plan-cta portal-primary"
                disabled={busy || !onChoose}
                type="button"
                onClick={() => onChoose?.(plan.id)}
              >
                {busy ? 'Activation...' : (
                  <>
                    {plan.priceLabel === 'Gratuit' ? 'Commencer gratuitement' : 'Choisir ce forfait'}
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            )}
          </article>
        )
      })}
    </div>
  )
}

function PlansView({ currentPlanId }: { currentPlanId?: string }) {
  const plan = planById(currentPlanId)
  return (
    <section className="plans-view">
      <header className="page-heading">
        <div>
          <p className="portal-kicker">Abonnement</p>
          <h1>Votre forfait</h1>
          <p>Forfait actuel : <strong>{plan.name}</strong>. Les offres payantes arrivent bientôt.</p>
        </div>
      </header>
      <PlanCards currentPlanId={currentPlanId ?? DEFAULT_PLAN_ID} />
    </section>
  )
}

// Écran plein affiché juste après l'inscription : l'utilisateur choisit son
// forfait avant d'entrer dans le dashboard.
function PlanOnboarding({
  user,
  onChoose,
}: {
  user: PortalUser
  onChoose: (planId: PlanId) => Promise<void>
}) {
  const [choosing, setChoosing] = useState<PlanId | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = (planId: PlanId) => {
    setChoosing(planId)
    setError(null)
    onChoose(planId).catch((chooseError: unknown) => {
      setError(
        chooseError instanceof Error
          ? chooseError.message
          : 'Impossible d’enregistrer le forfait.',
      )
      setChoosing(null)
    })
  }

  return (
    <main className="plan-onboarding">
      <header className="plan-onboarding-head">
        <span className="portal-logo"><Compass size={24} /></span>
        <p className="portal-kicker">Bienvenue {user.name.split(' ')[0]}</p>
        <h1>Choisissez votre forfait</h1>
        <p>Commencez gratuitement avec 5 Go de stockage. Vous pourrez changer à tout moment.</p>
      </header>
      {error ? <p className="auth-error">{error}</p> : null}
      <PlanCards choosing={choosing} onChoose={choose} />
    </main>
  )
}

// Page CGU + politique de confidentialité + mentions légales. Publique (lisible
// connecté comme déconnecté), atteinte sur /terms. PREMIER JET juridique : à faire
// relire avant le lancement public (cf. docs/PLAN-moderation-ia.md, brique 3).
function TermsView({ onClose }: { onClose: () => void }) {
  const updatedOn = '21 juin 2026'
  return (
    <main className="terms-page">
      <header className="terms-head">
        <button className="terms-back" type="button" onClick={onClose}>
          <ChevronRight size={16} style={{ transform: 'rotate(180deg)' }} /> Retour
        </button>
        <span className="portal-logo"><Compass size={22} /></span>
      </header>
      <div className="terms-doc">
        <p className="terms-kicker">Relieo</p>
        <h1>Conditions d’utilisation &amp; confidentialité</h1>
        <p className="terms-updated">Dernière mise à jour : {updatedOn}</p>

        <section className="terms-section">
          <h2>1. Conditions générales d’utilisation</h2>
          <h3>1.1 Objet</h3>
          <p>
            Relieo est un service en ligne permettant de créer des cartes
            interactives 3D et d’y associer des photos et vidéos. L’utilisation du
            service implique l’acceptation pleine et entière des présentes
            conditions.
          </p>
          <h3>1.2 Compte</h3>
          <p>
            La création d’un compte nécessite une adresse email valide, vérifiée à
            l’inscription. Vous êtes responsable de la confidentialité de vos
            identifiants et de toute activité réalisée depuis votre compte.
          </p>
          <h3>1.3 Vos contenus</h3>
          <p>
            Vous conservez la propriété des médias et cartes que vous publiez. Vous
            garantissez disposer des droits nécessaires sur les contenus mis en
            ligne et vous engagez à ne pas publier de contenu illicite, haineux,
            violent ou à caractère sexuel explicite.
          </p>
          <h3>1.4 Modération des contenus par une IA</h3>
          <p>
            <strong>
              Vous acceptez expressément que les médias (photos et vidéos) que vous
              publiez soient analysés par un service automatisé de modération afin
              de détecter les contenus inappropriés (nudité explicite, violence,
              symboles ou gestes haineux).
            </strong>{' '}
            Cette analyse est réalisée par notre sous-traitant <strong>Sightengine</strong>
            {' '}(société française, traitement des données dans l’Union européenne,
            suppression des fichiers immédiatement après analyse). Un contenu signalé
            peut être masqué au public puis, après revue, retiré. Voir la politique
            de confidentialité ci-dessous.
          </p>
          <h3>1.5 Modération et sanctions</h3>
          <p>
            Nous nous réservons le droit de dépublier ou supprimer un contenu, et de
            suspendre ou supprimer un compte ne respectant pas ces conditions. Vous
            êtes informé par notification et, le cas échéant, par email, et pouvez
            adresser un message de contestation.
          </p>
          <h3>1.6 Disponibilité &amp; responsabilité</h3>
          <p>
            Le service est fourni « en l’état », sans garantie de disponibilité
            continue. Nous ne saurions être tenus responsables d’une perte de
            données, dans la limite permise par la loi. Pensez à conserver une copie
            de vos contenus importants.
          </p>
          <h3>1.7 Évolution des conditions</h3>
          <p>
            Ces conditions peuvent évoluer. En cas de modification substantielle,
            une nouvelle acceptation pourra vous être demandée.
          </p>
        </section>

        <section className="terms-section">
          <h2>2. Politique de confidentialité</h2>
          <h3>2.1 Données collectées</h3>
          <p>
            Nous traitons : votre adresse email et les informations de votre profil
            (nom, localisation, bio, photo), vos cartes et médias, ainsi que des
            données techniques nécessaires au fonctionnement du service.
          </p>
          <h3>2.2 Finalités &amp; sous-traitants</h3>
          <p>Vos données sont utilisées pour fournir le service. Nos sous-traitants :</p>
          <ul>
            <li><strong>Firebase (Google)</strong> — authentification et profils.</li>
            <li><strong>Cloudflare R2</strong> — stockage des cartes et médias.</li>
            <li><strong>Vercel</strong> — hébergement de l’application.</li>
            <li><strong>Resend</strong> — envoi des emails transactionnels.</li>
            <li>
              <strong>Sightengine</strong> — modération automatisée des médias
              publiés (UE, suppression immédiate après analyse). Base légale :
              intérêt légitime à garantir un service sûr et votre consentement
              exprès recueilli à l’acceptation des présentes.
            </li>
          </ul>
          <h3>2.3 Conservation</h3>
          <p>
            Vos données sont conservées tant que votre compte est actif. Les
            fichiers transmis à Sightengine pour analyse sont supprimés
            immédiatement après traitement. La suppression de votre compte efface
            vos contenus.
          </p>
          <h3>2.4 Vos droits</h3>
          <p>
            Conformément au RGPD, vous disposez d’un droit d’accès, de
            rectification, d’effacement et de portabilité de vos données. Vous
            pouvez supprimer votre compte depuis votre profil, ou nous contacter à
            l’adresse ci-dessous.
          </p>
        </section>

        <section className="terms-section">
          <h2>3. Mentions légales</h2>
          <p>
            Éditeur : Relieo — <em>[identité de l’éditeur à compléter]</em>.<br />
            Contact : <a href="mailto:contact@relieo.fr">contact@relieo.fr</a>.<br />
            Hébergement : Vercel Inc. et Cloudflare, Inc.
          </p>
          <p className="terms-draft-note">
            Document de travail (premier jet) à faire relire avant le lancement
            public.
          </p>
        </section>
      </div>
    </main>
  )
}

// Écran de consentement bloquant, affiché après l’inscription (et aux comptes
// existants n’ayant pas encore accepté) avant l’accès au dashboard. Calqué sur
// PlanOnboarding.
function TermsOnboarding({
  user,
  onAccept,
  onViewTerms,
}: {
  user: PortalUser
  onAccept: () => Promise<void>
  onViewTerms: () => void
}) {
  const [checked, setChecked] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accept = () => {
    setAccepting(true)
    setError(null)
    onAccept().catch((acceptError: unknown) => {
      setError(
        acceptError instanceof Error
          ? acceptError.message
          : 'Impossible d’enregistrer votre acceptation.',
      )
      setAccepting(false)
    })
  }

  return (
    <main className="plan-onboarding terms-onboarding">
      <header className="plan-onboarding-head">
        <span className="portal-logo"><ShieldCheck size={24} /></span>
        <p className="portal-kicker">Bienvenue {user.name.split(' ')[0]}</p>
        <h1>Conditions d’utilisation</h1>
        <p>
          Avant de commencer, merci d’accepter nos conditions. Point important : les
          médias que vous publiez sont analysés par une IA de modération
          (Sightengine, UE) pour garder Relieo sûr pour tous.
        </p>
      </header>
      {error ? <p className="auth-error">{error}</p> : null}
      <div className="terms-onboarding-card">
        <label className="terms-consent">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>
            J’ai lu et j’accepte les{' '}
            <button className="terms-inline-link" type="button" onClick={onViewTerms}>
              conditions d’utilisation et la politique de confidentialité
            </button>
            , y compris la modération automatisée de mes médias.
          </span>
        </label>
        <button
          className="portal-primary terms-accept"
          type="button"
          disabled={!checked || accepting}
          onClick={accept}
        >
          {accepting ? 'Enregistrement…' : 'J’accepte et je continue'}
        </button>
      </div>
    </main>
  )
}

function DashboardShell({
  user,
  onLogout,
  onSaveProfile,
  onSavePhoto,
  canChangePassword,
  onChangePassword,
}: {
  user: PortalUser
  onLogout: () => void
  onSaveProfile: (user: PortalUser) => Promise<void>
  onSavePhoto: (photoURL: string) => Promise<void>
  canChangePassword: boolean
  onChangePassword: (current: string, next: string) => Promise<void>
}) {
  const [view, setView] = useState<PortalView>(currentView)
  const [hikes, setHikes] = useState<PortalHike[]>([])
  const [hikesError, setHikesError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [profile, setProfile] = useState(user)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [notifications, setNotifications] = useState<PortalNotification[]>([])
  const [notifOpen, setNotifOpen] = useState(false)
  // Acquittement du popup plein écran des notifications critiques (sanctions).
  const [criticalAck, setCriticalAck] = useState(false)

  useEffect(() => {
    const syncView = () => setView(currentView())
    window.addEventListener('popstate', syncView)
    return () => window.removeEventListener('popstate', syncView)
  }, [])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void getIdToken()
      .then((token) => {
        if (!token) return null
        return fetch('/api/usage', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
      })
      .then(async (response) => {
        if (!response || !response.ok) return
        const data = (await response.json().catch(() => null)) as
          | StorageUsage
          | null
        if (!cancelled && data && typeof data.usedBytes === 'number') {
          setUsage({ usedBytes: data.usedBytes, limitBytes: data.limitBytes })
        }
      })
      .catch(() => {
        // Jauge purement informative : on ignore les erreurs silencieusement.
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [user.id])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void getIdToken()
      .then(async (token) => {
        if (!token) throw new Error('Connexion Firebase requise.')
        // Ticket « scope user » posé AVANT de rendre les covers (servies par le
        // videur media.relieo.fr), pour qu'elles s'affichent sans 403.
        await requestMediaTicket({ scope: 'user' }, token)
        return fetch('/api/hikes', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        })
      })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as {
          hikes?: BackendHike[]
          message?: string
        } | null
        if (!response.ok) {
          throw new Error(data?.message ?? 'Lecture des cartes impossible.')
        }
        return data
      })
      .then((data) => {
        if (cancelled) return
        setHikes(backendHikes(data?.hikes ?? [], user.id))
        setHikesError(null)
      })
      .catch((loadError: unknown) => {
        if (cancelled || controller.signal.aborted) return
        setHikesError(
          loadError instanceof Error
            ? loadError.message
            : 'Lecture des cartes impossible.',
        )
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [user.id])

  // Renouvellement du ticket d'accès média « scope user » (covers du dashboard).
  useEffect(
    () => startMediaTicketRefresh({ scope: 'user' }, getIdToken),
    [user.id],
  )

  useEffect(() => {
    let cancelled = false
    void readUserNotifications(user.id)
      .then((items) => {
        if (!cancelled) setNotifications(items)
      })
      .catch(() => {
        if (!cancelled) setNotifications([])
      })
    return () => {
      cancelled = true
    }
  }, [user.id])

  const unreadCount = notifications.filter((n) => !n.read).length
  // Notifications non lues d'un type mis en avant : affichées en plein écran à
  // l'arrivée (cf. POPUP_NOTIF_TYPES).
  const popupNotifs = notifications.filter(
    (n) => !n.read && POPUP_NOTIF_TYPES.includes(n.type),
  )

  // Ouvre le menu de notifications et marque les non-lues comme lues (la pastille
  // rouge disparaît une fois la cloche consultée). Les notifs restent listées.
  const openNotifications = () => {
    setNotifOpen((open) => !open)
    if (!notifOpen && unreadCount > 0) {
      const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id)
      setNotifications((current) =>
        current.map((n) => ({ ...n, read: true })),
      )
      void markUserNotificationsRead(user.id, unreadIds).catch(() => undefined)
    }
  }

  // Acquittement du popup : marque ces notifs lues (conservées dans l'historique).
  const ackCritical = () => {
    const ids = popupNotifs.map((n) => n.id)
    setNotifications((current) =>
      current.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n)),
    )
    setCriticalAck(true)
    void markUserNotificationsRead(user.id, ids).catch(() => undefined)
  }

  const setPortalView = (next: PortalView) => {
    const target = next !== 'tracker' && hasLocalTraceDraft() ? 'tracker' : next
    const path =
      target === 'tracker'
        ? '/tracker'
        : target === 'dashboard'
          ? '/dashboard'
          : `/dashboard/${target}`
    navigate(path)
    setView(target)
    setMobileMenu(false)
    setNotifOpen(false)
  }

  const filteredHikes = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return hikes
    return hikes.filter((hike) => `${hike.title} ${hike.code}`.toLowerCase().includes(query))
  }, [hikes, search])

  const totals = useMemo(
    () => ({
      distance: hikes.reduce((sum, hike) => sum + hike.distanceKm, 0),
      media: hikes.reduce((sum, hike) => sum + hike.mediaCount, 0),
      gain: hikes.reduce((sum, hike) => sum + hike.elevationGain, 0),
    }),
    [hikes],
  )

  // Carte la plus récemment modifiée : alimente le panneau « Activité récente ».
  const recentHike = useMemo(
    () =>
      hikes.reduce<PortalHike | null>(
        (latest, hike) =>
          !latest || new Date(hike.updatedAt) > new Date(latest.updatedAt)
            ? hike
            : latest,
        null,
      ),
    [hikes],
  )

  const createHike = (title: string, code: string) => {
    setCreateOpen(false)
    window.location.assign(
      `/?mode=studio&new=${encodeURIComponent(code)}&title=${encodeURIComponent(title)}`,
    )
  }

  // Dépublier (→ brouillon) / publier (→ en ligne) une de SES cartes, sans
  // toucher au contenu. Une carte dépubliée n'est plus accessible par son code.
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const toggleHikeStatus = async (hike: PortalHike) => {
    const next = hike.status === 'published' ? 'draft' : 'published'
    setStatusBusy(hike.code)
    try {
      const token = await getIdToken()
      if (!token) throw new Error('Connexion requise.')
      const response = await fetch('/api/hikes', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code: hike.code, status: next }),
      })
      if (!response.ok) throw new Error()
      setHikes((current) =>
        current.map((h) => (h.code === hike.code ? { ...h, status: next } : h)),
      )
      setHikesError(null)
    } catch {
      setHikesError('Changement de statut impossible.')
    } finally {
      setStatusBusy(null)
    }
  }

  const saveProfile = async (next: PortalUser) => {
    await onSaveProfile(next)
    setProfile(next)
  }

  const savePhoto = async (photoURL: string) => {
    await onSavePhoto(photoURL)
    setProfile((current) => ({ ...current, photoURL }))
  }

  if (view === 'tracker') {
    return <TraceRecorderScreen onClose={() => setPortalView('traces')} />
  }

  return (
    <div className="portal-shell">
      <aside className={mobileMenu ? 'portal-sidebar open' : 'portal-sidebar'}>
        <div className="sidebar-brand"><span className="portal-logo"><Compass size={22} /></span><strong>Relieo</strong></div>
        <nav aria-label="Navigation principale">
          <p>ESPACE</p>
          <button className={view === 'dashboard' ? 'active' : ''} type="button" onClick={() => setPortalView('dashboard')}><LayoutDashboard size={18} /> Vue d’ensemble</button>
          <button className={view === 'hikes' ? 'active' : ''} type="button" onClick={() => setPortalView('hikes')}><Map size={18} /> Mes cartes <span>{hikes.length}</span></button>
          <button className={view === 'profile' ? 'active' : ''} type="button" onClick={() => setPortalView('profile')}><UserRound size={18} /> Mon profil</button>
          <button className={view === 'plans' ? 'active' : ''} type="button" onClick={() => setPortalView('plans')}><Wallet size={18} /> Forfait</button>
          <p>OUTILS</p>
          <button className={view === 'traces' ? 'active' : ''} type="button" onClick={() => setPortalView('traces')}><Route size={18} /> Mes traces</button>
          <button type="button"><BarChart3 size={18} /> Statistiques</button>
          <button className={view === 'settings' ? 'active' : ''} type="button" onClick={() => setPortalView('settings')}><Settings size={18} /> Paramètres</button>
        </nav>
        <div className="sidebar-status"><span><ShieldCheck size={16} /></span><div><strong>Cloud synchronisé</strong><small>Firebase + Cloudflare R2</small></div></div>
        <button className="logout-button" type="button" onClick={onLogout}><LogOut size={18} /> Déconnexion</button>
      </aside>

      <main className="portal-main">
        <header className="portal-topbar">
          <button aria-label="Menu" className="icon-button mobile-menu-button" type="button" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button>
          <label className="portal-search"><Search size={18} /><input placeholder="Rechercher une carte" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="topbar-actions">
            <div className="notif-bell-wrap">
              <button
                aria-label="Notifications"
                className="icon-button notif-bell"
                type="button"
                onClick={openNotifications}
              >
                <Bell size={19} />
                {unreadCount > 0 ? (
                  <span className="notif-bell-badge">{unreadCount}</span>
                ) : null}
              </button>
              {notifOpen ? (
                <>
                  <button
                    aria-label="Fermer"
                    className="notif-menu-scrim"
                    type="button"
                    onClick={() => setNotifOpen(false)}
                  />
                  <div className="notif-menu">
                    <header className="notif-menu-head">Notifications</header>
                    {notifications.length === 0 ? (
                      <p className="notif-menu-empty">Aucune notification.</p>
                    ) : (
                      <ul className="notif-menu-list">
                        {notifications.slice(0, 3).map((item) => (
                          <li key={item.id}>
                            {notifTitle(item) ? (
                              <strong>{notifTitle(item)}</strong>
                            ) : null}
                            <p>{item.message}</p>
                            <time>{formatDate(item.createdAt)}</time>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      className="notif-menu-all"
                      type="button"
                      onClick={() => setPortalView('notifications')}
                    >
                      Voir toutes les notifications <ChevronRight size={15} />
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <button className="profile-button" type="button" onClick={() => setPortalView('profile')}><span className="profile-avatar" style={avatarStyle(profile.photoURL)}>{profile.photoURL ? '' : userInitials(profile.name)}</span><span><strong>{profile.name}</strong><small>{profile.email}</small></span></button>
          </div>
        </header>

        <div className="portal-content">
          {view === 'settings' ? (
            <SettingsView />
          ) : view === 'profile' ? (
            <ProfileView
              user={profile}
              onSave={saveProfile}
              onSavePhoto={savePhoto}
              canChangePassword={canChangePassword}
              onChangePassword={onChangePassword}
            />
          ) : view === 'plans' ? (
            <PlansView currentPlanId={profile.plan ?? DEFAULT_PLAN_ID} />
          ) : view === 'traces' ? (
            <TracesView
              onStart={() => setPortalView('tracker')}
              hikes={hikes.map((hike) => ({
                code: hike.code,
                title: hike.title,
                status: hike.status,
              }))}
            />
          ) : view === 'notifications' ? (
            <>
              <header className="page-heading">
                <div>
                  <p className="portal-kicker">Notifications</p>
                  <h1>Vos notifications</h1>
                  <p>Les messages de l’administrateur et les événements de vos cartes.</p>
                </div>
              </header>
              <section className="notif-page">
                {notifications.length === 0 ? (
                  <div className="notif-page-empty">
                    <span><Bell size={26} /></span>
                    <strong>Aucune notification</strong>
                    <p>Les messages de l’administrateur et les événements de vos cartes apparaîtront ici.</p>
                  </div>
                ) : (
                  notifications.map((item) => {
                    const visual = notifVisual(item.type)
                    return (
                      <article
                        className={`notif-page-card ${visual.tone}${item.read ? '' : ' unread'}`}
                        key={item.id}
                      >
                        <span className={`notif-page-icon ${visual.tone}`}>{visual.icon}</span>
                        <div className="notif-page-body">
                          <div className="notif-page-titleline">
                            <strong>{notifTitle(item)}</strong>
                            {item.read ? null : <span className="notif-page-dot" />}
                          </div>
                          <p>{item.message}</p>
                          <time>{formatDate(item.createdAt)}</time>
                        </div>
                      </article>
                    )
                  })
                )}
              </section>
            </>
          ) : (
            <>
              <header className="page-heading">
                <div><p className="portal-kicker">{view === 'hikes' ? 'Bibliothèque' : 'Tableau de bord'}</p><h1>{view === 'hikes' ? 'Toutes vos cartes' : `Bonjour ${profile.name.split(' ')[0]}`}</h1><p>{view === 'hikes' ? 'Retrouvez les projets publiés et les brouillons.' : 'Votre espace personnel pour créer et raconter vos aventures.'}</p></div>
                <button className="portal-primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={18} /> Nouvelle carte</button>
              </header>

              {view === 'dashboard' ? (
                <section className="summary-grid" aria-label="Résumé">
                  <article className="summary-card featured"><span><FolderKanban size={19} /></span><p>Cartes</p><strong>{hikes.length}</strong><small>{hikes.filter((hike) => hike.status === 'published').length} publiée</small></article>
                  <article className="summary-card"><span><Route size={19} /></span><p>Distance totale</p><strong>{totals.distance.toLocaleString('fr-FR')} km</strong><small>sur tous vos parcours</small></article>
                  <article className="summary-card"><span><Gauge size={19} /></span><p>Dénivelé cumulé</p><strong>{totals.gain.toLocaleString('fr-FR')} m</strong><small>de montée enregistrée</small></article>
                  <article className="summary-card"><span><Image size={19} /></span><p>Médias</p><strong>{totals.media}</strong><small>photos et vidéos</small></article>
                </section>
              ) : null}

              <section className="hikes-section">
                <div className="section-heading"><div><h2>{view === 'hikes' ? 'Bibliothèque' : 'Cartes récentes'}</h2><p>{filteredHikes.length} projet{filteredHikes.length > 1 ? 's' : ''}</p></div>{view === 'dashboard' ? <button type="button" onClick={() => setPortalView('hikes')}>Tout afficher <ChevronRight size={16} /></button> : null}</div>
                {hikesError ? <p className="auth-error">{hikesError}</p> : null}
                <div className="hikes-grid">
                  {filteredHikes.map((hike) => (
                    <HikeCard
                      busy={statusBusy === hike.code}
                      hike={hike}
                      key={hike.id}
                      onToggleStatus={toggleHikeStatus}
                    />
                  ))}
                  <button className="new-hike-card" type="button" onClick={() => setCreateOpen(true)}><span><Plus size={23} /></span><strong>Créer une carte</strong><small>Commencer avec un Studio 3D vierge</small></button>
                </div>
              </section>

              {view === 'dashboard' ? (
                <section className="dashboard-bottom-grid">
                  <article className="activity-panel">
                    <div className="section-heading"><div><h2>Activité récente</h2><p>Votre dernier projet</p></div></div>
                    {recentHike ? (
                      <div className="activity-line">
                        <span className="activity-icon"><Mountain size={19} /></span>
                        <div>
                          <strong>
                            {recentHike.title}{' '}
                            {recentHike.status === 'published'
                              ? 'a été publiée'
                              : 'enregistrée en brouillon'}
                          </strong>
                          <p>{recentHike.pointCount} points et {recentHike.mediaCount} médias synchronisés</p>
                        </div>
                        <time>{formatDate(recentHike.updatedAt)}</time>
                      </div>
                    ) : (
                      <div className="activity-line">
                        <span className="activity-icon"><Mountain size={19} /></span>
                        <div>
                          <strong>Aucun projet pour l’instant</strong>
                          <p>Créez votre première carte pour démarrer.</p>
                        </div>
                      </div>
                    )}
                  </article>
                  <article className="storage-panel">
                    <div>
                      <p className="portal-kicker">Stockage média</p>
                      <h2>Forfait {planById(profile.plan).name}</h2>
                      <p>Vos originaux restent centralisés et accessibles en qualité maximale.</p>
                    </div>
                    <div className="storage-meter">
                      <span
                        style={{
                          width: `${usage && usage.limitBytes > 0 ? Math.min(100, Math.round((usage.usedBytes / usage.limitBytes) * 100)) : 0}%`,
                        }}
                      />
                    </div>
                    <div className="storage-legend">
                      <strong>{usage ? `${formatBytes(usage.usedBytes)} utilisés` : 'Calcul en cours...'}</strong>
                      <span>Limite {formatBytes(usage?.limitBytes ?? 5_000_000_000)}</span>
                    </div>
                  </article>
                </section>
              ) : null}
            </>
          )}
        </div>
      </main>
      {mobileMenu ? <button aria-label="Fermer le menu" className="sidebar-scrim" type="button" onClick={() => setMobileMenu(false)} /> : null}
      {createOpen ? <CreateHikeDialog onClose={() => setCreateOpen(false)} onCreate={createHike} /> : null}

      {!criticalAck && popupNotifs.length > 0 ? (
        <div className="portal-modal-backdrop" role="dialog" aria-modal="true">
          <div className="portal-modal">
            <span className="portal-modal-icon"><Bell size={24} /></span>
            <h2>{popupNotifs.length > 1 ? 'Vous avez de nouvelles notifications' : 'Nouvelle notification'}</h2>
            <ul className="portal-notif-list">
              {popupNotifs.map((item) => {
                const visual = notifVisual(item.type)
                return (
                  <li className="portal-notif-item" key={item.id}>
                    <span className={`notif-page-icon ${visual.tone}`}>{visual.icon}</span>
                    <div>
                      <p className="portal-notif-title">{notifTitle(item)}</p>
                      <p className="portal-notif-message">{item.message}</p>
                      <span className="portal-notif-date">{formatDate(item.createdAt)}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
            <button className="portal-notif-ok" type="button" onClick={ackCritical}>
              J’ai compris
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// ---------- Auth Firebase (Google + e-mail/mot de passe) ----------

// Dérive un PortalUser depuis le compte Firebase. uid = identité/propriété.
const toPortalUser = (fb: User, extras: ProfileExtras): PortalUser => {
  return {
    id: fb.uid,
    name:
      extras.name || fb.displayName || fb.email?.split('@')[0] || 'Voyageur',
    email: fb.email ?? '',
    location: extras.location ?? 'France',
    bio:
      extras.bio ?? 'Je transforme mes aventures en récits cartographiques 3D.',
    createdAt: fb.metadata.creationTime ?? new Date().toISOString(),
    plan: extras.plan,
    photoURL: extras.photoURL ?? fb.photoURL ?? undefined,
    termsAccepted: extras.termsAccepted === true,
    termsAcceptedAt: extras.termsAcceptedAt,
  }
}

const firebaseErrorMessage = (error: unknown): string => {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email ou mot de passe incorrect.'
    case 'auth/email-already-in-use':
      return 'Un compte existe déjà avec cet email.'
    case 'auth/weak-password':
      return 'Le mot de passe ne respecte pas les règles de robustesse.'
    case 'auth/popup-closed-by-user':
      return 'Connexion Google annulée.'
    default:
      return error instanceof Error ? error.message : 'Connexion impossible.'
  }
}

const passwordChecks = (password: string) => [
  { label: '12 caractères minimum', valid: password.length >= 12 },
  { label: 'Une lettre minuscule', valid: /[a-z]/.test(password) },
  { label: 'Une lettre majuscule', valid: /[A-Z]/.test(password) },
  { label: 'Un chiffre', valid: /\d/.test(password) },
  {
    label: 'Un caractère spécial',
    valid: /[^A-Za-z0-9\s]/.test(password),
  },
]

function FirebaseAuthScreen({
  auth,
  notice,
}: {
  auth: ReturnType<typeof getFirebaseAuth>
  notice?: string | null
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const checks = passwordChecks(password)
  const passwordIsStrong = checks.every((check) => check.valid)
  const passwordsMatch = password === passwordConfirmation

  const changeMode = (nextMode: 'login' | 'signup') => {
    setMode(nextMode)
    setError(null)
    setResetSent(false)
    setPasswordConfirmation('')
    setShowPassword(false)
    setShowPasswordConfirmation(false)
  }

  // Mot de passe oublié : Firebase envoie le lien de réinitialisation. On ne
  // révèle jamais si l'email existe (anti-énumération) : compte introuvable =
  // même message de succès générique.
  const handleForgotPassword = async () => {
    if (!auth) return
    const target = email.trim()
    if (!target) {
      setError('Entre ton email ci-dessus pour recevoir le lien de réinitialisation.')
      return
    }
    setBusy(true)
    setError(null)
    setResetSent(false)
    try {
      await sendPasswordResetEmail(auth, target)
      setResetSent(true)
    } catch (resetError) {
      if ((resetError as { code?: string }).code === 'auth/user-not-found') {
        setResetSent(true)
      } else {
        setError(firebaseErrorMessage(resetError))
      }
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: () => Promise<unknown>) => {
    if (!auth) return
    setBusy(true)
    setError(null)
    try {
      await action()
      navigate('/dashboard')
    } catch (authError) {
      setError(firebaseErrorMessage(authError))
    } finally {
      setBusy(false)
    }
  }

  const submitEmail = (event: FormEvent) => {
    event.preventDefault()
    if (!auth) return
    if (mode === 'signup' && !passwordIsStrong) {
      setError('Respecte tous les critères de robustesse du mot de passe.')
      return
    }
    if (mode === 'signup' && !passwordsMatch) {
      setError('Les deux mots de passe doivent être identiques.')
      return
    }
    void run(async () => {
      if (mode === 'signup') {
        const credential = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        )
        if (name.trim()) {
          await updateProfile(credential.user, { displayName: name.trim() })
        }
        await saveUserProfile(credential.user.uid, {
          name: name.trim() || 'Voyageur',
          location: 'France',
          bio: 'Je transforme mes aventures en récits cartographiques 3D.',
        })
        // Envoi du lien de vérification : l'accès au compte reste bloqué tant
        // que l'email n'est pas validé (géré dans FirebasePortal).
        await requestEmailVerification(credential.user)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    })
  }

  return (
    <main className="portal-auth">
      <section className="auth-visual" aria-label="Présentation Relieo">
        <HeroSlideshow />
        <div className="auth-brand">
          <span className="portal-logo"><Compass size={24} /></span>
          <strong>Relieo</strong>
        </div>
        <div className="auth-visual-copy">
          <p className="portal-kicker">Votre carnet cartographique</p>
          <h1>Retrouvez chaque carte, chaque image, au bon endroit.</h1>
          <div className="auth-proof">
            <span><Mountain size={17} /> Relief 3D</span>
            <span><Camera size={17} /> Médias géolocalisés</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-form-wrap">
          <h2>{mode === 'signup' ? 'Créer votre espace' : 'Bon retour parmi nous'}</h2>
          <p>Connectez-vous pour retrouver vos cartes 3D.</p>
          {notice ? (
            <p className="auth-device-warning">
              <Monitor aria-hidden="true" size={16} />
              <span>{notice}</span>
            </p>
          ) : null}

          <button
            className="google-btn"
            disabled={busy}
            type="button"
            onClick={() => auth && void run(() => signInWithPopup(auth, googleProvider))}
          >
            <GoogleGlyph /> Continuer avec Google
          </button>

          <div className="auth-divider"><span>ou</span></div>

          <div className="auth-switch" role="tablist" aria-label="Authentification">
            <button className={mode === 'login' ? 'active' : ''} role="tab" type="button" onClick={() => changeMode('login')}>Connexion</button>
            <button className={mode === 'signup' ? 'active' : ''} role="tab" type="button" onClick={() => changeMode('signup')}>Inscription</button>
          </div>

          <form className="auth-form" onSubmit={submitEmail}>
            {mode === 'signup' ? (
              <label>
                <span>Nom</span>
                <div className="input-shell"><UserRound size={17} /><input value={name} onChange={(event) => setName(event.target.value)} /></div>
              </label>
            ) : null}
            <label>
              <span>Email</span>
              <div className="input-shell"><CircleUserRound size={17} /><input autoComplete="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            </label>
            <label>
              <span>Mot de passe</span>
              <div className="input-shell">
                <KeyRound size={17} />
                <input
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  minLength={mode === 'signup' ? 12 : 6}
                  required
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  className="password-visibility"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            {mode === 'login' ? (
              <button
                className="auth-forgot"
                disabled={busy}
                type="button"
                onClick={() => void handleForgotPassword()}
              >
                Mot de passe oublié ?
              </button>
            ) : null}
            {resetSent ? (
              <p className="auth-success-note">
                Si un compte existe pour cet email, un lien de réinitialisation
                vient d'être envoyé. Pense à vérifier tes spams.
              </p>
            ) : null}
            {mode === 'signup' ? (
              <>
                <ul className="password-rules" aria-label="Règles du mot de passe">
                  {checks.map((check) => (
                    <li className={check.valid ? 'valid' : ''} key={check.label}>
                      <Check aria-hidden="true" size={13} />
                      {check.label}
                    </li>
                  ))}
                </ul>
                <label>
                  <span>Confirmer le mot de passe</span>
                  <div className="input-shell">
                    <KeyRound size={17} />
                    <input
                      aria-invalid={passwordConfirmation.length > 0 && !passwordsMatch}
                      autoComplete="new-password"
                      minLength={12}
                      required
                      type={showPasswordConfirmation ? 'text' : 'password'}
                      value={passwordConfirmation}
                      onChange={(event) => setPasswordConfirmation(event.target.value)}
                    />
                    <button
                      aria-label={showPasswordConfirmation ? 'Masquer la confirmation' : 'Afficher la confirmation'}
                      className="password-visibility"
                      type="button"
                      onClick={() => setShowPasswordConfirmation((visible) => !visible)}
                    >
                      {showPasswordConfirmation ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  {passwordConfirmation ? (
                    <small className={passwordsMatch ? 'password-match valid' : 'password-match'}>
                      {passwordsMatch ? 'Les mots de passe correspondent.' : 'Les mots de passe ne correspondent pas.'}
                    </small>
                  ) : null}
                </label>
              </>
            ) : null}
            {error ? <p className="auth-error">{error}</p> : null}
            <button className="portal-primary auth-submit" disabled={busy} type="submit">
              {busy ? 'Vérification...' : mode === 'signup' ? 'Créer mon espace' : 'Se connecter'}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-terms-link">
            En continuant, vous acceptez nos{' '}
            <button
              className="terms-inline-link"
              type="button"
              onClick={() => navigate('/terms')}
            >
              conditions d’utilisation
            </button>
            .
          </p>
        </div>
      </section>
    </main>
  )
}

// Petit logo Google en SVG (évite une dépendance d'icône).
function GoogleGlyph() {
  return (
    <svg aria-hidden="true" height="18" viewBox="0 0 48 48" width="18">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

// Écran bloquant tant que l'email n'est pas validé. L'utilisateur clique le
// lien reçu (qui ouvre la page Firebase), puis revient confirmer ici.
function VerifyEmailScreen({
  user,
  onRecheck,
  onResend,
  onLogout,
}: {
  user: User
  onRecheck: () => Promise<boolean>
  onResend: () => Promise<void>
  onLogout: () => void
}) {
  const [status, setStatus] = useState<string | null>(null)
  const [resent, setResent] = useState(false)
  const [busy, setBusy] = useState(false)

  const recheck = () => {
    setBusy(true)
    setStatus(null)
    setResent(false)
    onRecheck()
      .then((verified) => {
        if (!verified) {
          setStatus(
            'Email pas encore validé. Clique le lien reçu, puis réessaie.',
          )
        }
      })
      .catch(() => setStatus('Vérification impossible. Réessaie.'))
      .finally(() => setBusy(false))
  }

  const resend = () => {
    setBusy(true)
    setStatus(null)
    onResend()
      .then(() => setResent(true))
      .catch(() =>
        setStatus('Envoi impossible. Patiente un instant avant de réessayer.'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <main className="portal-auth verify-screen">
      <section className="auth-panel">
        <div className="auth-form-wrap verify-wrap">
          <span className="verify-icon"><MailCheck size={26} /></span>
          <h2>Validez votre adresse email</h2>
          <p>
            Un lien de vérification a été envoyé à{' '}
            <strong>{user.email}</strong>. Cliquez dessus pour activer votre
            compte, puis revenez confirmer ici.
          </p>
          {status ? <p className="auth-error">{status}</p> : null}
          {resent ? (
            <p className="verify-success"><Check size={15} /> Email renvoyé.</p>
          ) : null}
          <button className="portal-primary" disabled={busy} type="button" onClick={recheck}>
            {busy ? 'Vérification...' : 'J’ai validé mon email'}
            <ArrowRight size={17} />
          </button>
          <button className="verify-secondary" disabled={busy} type="button" onClick={resend}>
            Renvoyer l’email
          </button>
          <button className="verify-link" type="button" onClick={onLogout}>
            <LogOut size={15} /> Se déconnecter
          </button>
        </div>
      </section>
    </main>
  )
}

// Écran d'un compte banni : message admin + 1 message d'appel possible.
function BlockedScreen({
  message,
  appealSent,
  adminReply,
  onAppeal,
  onLogout,
}: {
  message: string
  appealSent: boolean
  adminReply: string | null
  onAppeal: (message: string) => Promise<void>
  onLogout: () => void
}) {
  const [text, setText] = useState('')
  const [sent, setSent] = useState(appealSent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = () => {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    onAppeal(text.trim())
      .then(() => setSent(true))
      .catch((sendError: unknown) =>
        setError(sendError instanceof Error ? sendError.message : 'Envoi impossible.'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <main className="portal-auth sanction-screen blocked">
      <section className="auth-panel">
        <div className="auth-form-wrap sanction-wrap">
          <span className="sanction-icon blocked"><Ban size={26} /></span>
          <h2>Votre compte est bloqué</h2>
          <p className="sanction-message">{message || 'Votre accès a été suspendu par un administrateur.'}</p>
          {adminReply ? (
            <div className="sanction-reply">
              <span className="sanction-reply-label">Réponse de l’administrateur</span>
              <p>{adminReply}</p>
            </div>
          ) : null}
          {sent ? (
            <p className="verify-success"><Check size={15} /> Message envoyé à l’administrateur.</p>
          ) : (
            <>
              <label className="sanction-label" htmlFor="appeal">
                Un message à l’administrateur (1 seul possible)
              </label>
              <textarea
                className="sanction-textarea"
                id="appeal"
                placeholder="Expliquez votre situation…"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              {error ? <p className="auth-error">{error}</p> : null}
              <button
                className="portal-primary"
                disabled={busy || !text.trim()}
                type="button"
                onClick={send}
              >
                {busy ? 'Envoi…' : 'Envoyer le message'}
                <ArrowRight size={17} />
              </button>
            </>
          )}
          <button className="verify-link" type="button" onClick={onLogout}>
            <LogOut size={15} /> Se déconnecter
          </button>
        </div>
      </section>
    </main>
  )
}

// Écran d'un compte supprimé : message admin + déconnexion. Au montage, on
// désactive le compte (reconnexion et recréation avec le même email impossibles).
function DeletedScreen({
  message,
  onLogout,
}: {
  message: string
  onLogout: () => void
}) {
  useEffect(() => {
    void finalizeAccountDeletion()
  }, [])

  return (
    <main className="portal-auth sanction-screen deleted">
      <section className="auth-panel">
        <div className="auth-form-wrap sanction-wrap">
          <span className="sanction-icon deleted"><Ban size={26} /></span>
          <h2>Votre compte a été supprimé</h2>
          <p className="sanction-message">{message || 'Votre compte et son contenu ont été supprimés par un administrateur.'}</p>
          <p className="sanction-note">Vous ne pourrez plus vous reconnecter avec cette adresse.</p>
          <button className="verify-link" type="button" onClick={onLogout}>
            <LogOut size={15} /> Se déconnecter
          </button>
        </div>
      </section>
    </main>
  )
}

function FirebasePortal() {
  const auth = getFirebaseAuth()
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<{
    firebaseUser: User
    portalUser: PortalUser
  } | null>(null)
  const [emailVerified, setEmailVerified] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(() =>
    window.sessionStorage.getItem(AUTH_NOTICE_STORAGE_KEY),
  )
  const [adminPhoneDevice, setAdminPhoneDevice] = useState(isAdminPhoneDevice)
  // Détection admin remontée ici (avant le dashboard) pour pouvoir sauter
  // l'écran de choix de forfait : l'admin (Dieu) n'a pas de forfait.
  const [admin, setAdmin] = useState<{ checked: boolean; isAdmin: boolean }>({
    checked: false,
    isAdmin: false,
  })
  // État de modération du compte (actif / bloqué / supprimé).
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null)
  // Chemin courant suivi au niveau racine, pour router la page /terms (publique)
  // que l'on soit connecté ou non.
  const [pathname, setPathname] = useState(window.location.pathname)
  useEffect(() => {
    const syncPath = () => setPathname(window.location.pathname)
    window.addEventListener('popstate', syncPath)
    return () => window.removeEventListener('popstate', syncPath)
  }, [])
  const adminPhoneBlocked =
    Boolean(session) && emailVerified && admin.checked && admin.isAdmin && adminPhoneDevice

  useEffect(() => {
    const refreshAdminPhoneDevice = () => {
      setAdminPhoneDevice(isAdminPhoneDevice())
    }

    refreshAdminPhoneDevice()
    window.addEventListener('resize', refreshAdminPhoneDevice)
    window.addEventListener('orientationchange', refreshAdminPhoneDevice)
    return () => {
      window.removeEventListener('resize', refreshAdminPhoneDevice)
      window.removeEventListener('orientationchange', refreshAdminPhoneDevice)
    }
  }, [])

  useEffect(() => {
    if (!session || !emailVerified) return
    let cancelled = false
    void getIdToken()
      .then((token) => {
        if (!token) return null
        return fetch('/api/admin/me', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
        })
      })
      .then(async (response) => {
        let isAdmin = false
        if (response && response.ok) {
          const data = (await response.json().catch(() => null)) as
            | { admin?: boolean }
            | null
          isAdmin = Boolean(data?.admin)
        }
        if (!cancelled) setAdmin({ checked: true, isAdmin })
      })
      .catch(() => {
        if (!cancelled) setAdmin({ checked: true, isAdmin: false })
      })
    return () => {
      cancelled = true
    }
  }, [session, emailVerified])

  // Charge l'état de modération du compte (bloqué / supprimé) après l'admin check.
  useEffect(() => {
    if (!session || !emailVerified || !admin.checked || admin.isAdmin) {
      // Réinitialise tant qu'on n'est pas un utilisateur prêt à router.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAccountStatus(null)
      return
    }
    let cancelled = false
    void readAccountStatus(session.firebaseUser.uid)
      .then((status) => {
        if (!cancelled) setAccountStatus(status)
      })
      .catch(() => {
        if (!cancelled)
          setAccountStatus({
            status: 'active',
            message: '',
            appealSent: false,
            adminReply: null,
            deletionRequested: false,
          })
      })
    return () => {
      cancelled = true
    }
  }, [session, emailVerified, admin])

  useEffect(() => {
    document.body.classList.add('portal-active')
    if (!auth) return () => document.body.classList.remove('portal-active')
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      if (!current) {
        setSession(null)
        setEmailVerified(false)
        setProfileError(null)
        setLoginNotice(window.sessionStorage.getItem(AUTH_NOTICE_STORAGE_KEY))
        setAdmin({ checked: false, isAdmin: false })
        setAccountStatus(null)
        setReady(true)
        return
      }
      window.sessionStorage.removeItem(AUTH_NOTICE_STORAGE_KEY)
      setLoginNotice(null)
      setEmailVerified(current.emailVerified)
      void readUserProfile(current.uid)
        .then((extras) => {
          setSession({
            firebaseUser: current,
            portalUser: toPortalUser(current, extras),
          })
          setProfileError(null)
        })
        .catch((loadError: unknown) => {
          setSession({
            firebaseUser: current,
            portalUser: toPortalUser(current, {}),
          })
          setProfileError(
            loadError instanceof Error
              ? loadError.message
              : 'Lecture du profil Firestore impossible.',
          )
        })
        .finally(() => setReady(true))
    })
    return () => {
      document.body.classList.remove('portal-active')
      unsubscribe()
    }
  }, [auth])

  useEffect(() => {
    if (!auth || !adminPhoneBlocked) return
    window.sessionStorage.setItem(AUTH_NOTICE_STORAGE_KEY, ADMIN_PHONE_NOTICE)
    void signOut(auth).finally(() => navigate('/login'))
  }, [adminPhoneBlocked, auth])

  // Page CGU : publique et prioritaire, accessible avant même la connexion.
  if (pathname.endsWith('/terms')) {
    return <TermsView onClose={() => navigate(session ? '/dashboard' : '/login')} />
  }

  if (!auth) {
    return (
      <main className="portal-auth">
        <section className="auth-panel">
          <div className="auth-form-wrap">
            <h2>Firebase non configuré</h2>
            <p>Les variables VITE_FIREBASE_* sont obligatoires.</p>
          </div>
        </section>
      </main>
    )
  }
  if (!ready) return null
  if (!session) return <FirebaseAuthScreen auth={auth} notice={loginNotice} />

  // Vérification email : accès bloqué tant que l'adresse n'est pas validée.
  // Les comptes Google arrivent déjà vérifiés et passent directement.
  if (!emailVerified) {
    return (
      <VerifyEmailScreen
        user={session.firebaseUser}
        onLogout={() => {
          void signOut(auth)
          navigate('/login')
        }}
        onRecheck={async () => {
          await session.firebaseUser.reload()
          const verified = auth.currentUser?.emailVerified ?? false
          setEmailVerified(verified)
          return verified
        }}
        onResend={async () => {
          await requestEmailVerification(session.firebaseUser)
        }}
      />
    )
  }

  // On attend la fin de la détection admin avant de router : un admin doit
  // atterrir sur sa console dédiée, jamais (même brièvement) sur le dashboard
  // utilisateur classique.
  if (!admin.checked) return null

  if (adminPhoneBlocked) return null

  // Admin : écran d'administration plein et totalement séparé. Pas de dashboard
  // utilisateur, pas de choix de forfait (le Dieu n'a pas de forfait).
  if (admin.isAdmin) {
    return (
      <AdminApp
        user={session.portalUser}
        onLogout={() => {
          void signOut(auth)
          navigate('/login')
        }}
      />
    )
  }

  // Compte sanctionné : on attend l'état de modération, puis on route vers
  // l'écran de blocage / suppression au lieu du dashboard. (les admins sont
  // exclus en amont par le test admin.isAdmin)
  if (!accountStatus) return null
  if (accountStatus.status === 'blocked') {
    return (
      <BlockedScreen
        adminReply={accountStatus.adminReply}
        appealSent={accountStatus.appealSent}
        message={accountStatus.message}
        onAppeal={(message) => sendAccountAppeal(message)}
        onLogout={() => {
          void signOut(auth)
          navigate('/login')
        }}
      />
    )
  }
  if (accountStatus.status === 'deleted') {
    return (
      <DeletedScreen
        message={accountStatus.message}
        onLogout={() => {
          void signOut(auth)
          navigate('/login')
        }}
      />
    )
  }

  // Étape post-inscription : tant qu'aucun forfait n'est choisi, on affiche
  // l'écran de sélection avant de donner accès au dashboard.
  if (!session.portalUser.plan) {
    return (
      <>
        {profileError ? <p className="auth-error">{profileError}</p> : null}
        <PlanOnboarding
          user={session.portalUser}
          onChoose={async (planId) => {
            await saveUserPlan(session.firebaseUser.uid, planId)
            setSession({
              firebaseUser: session.firebaseUser,
              portalUser: { ...session.portalUser, plan: planId },
            })
            navigate('/dashboard')
          }}
        />
      </>
    )
  }

  // Consentement CGU (modération IA incluse) obligatoire avant l'accès au
  // dashboard. Les comptes existants le voient à leur prochaine connexion.
  if (!session.portalUser.termsAccepted) {
    return (
      <>
        {profileError ? <p className="auth-error">{profileError}</p> : null}
        <TermsOnboarding
          user={session.portalUser}
          onViewTerms={() => navigate('/terms')}
          onAccept={async () => {
            const acceptedAt = await saveTermsAcceptance(session.firebaseUser.uid)
            setSession({
              firebaseUser: session.firebaseUser,
              portalUser: {
                ...session.portalUser,
                termsAccepted: true,
                termsAcceptedAt: acceptedAt,
              },
            })
            navigate('/dashboard')
          }}
        />
      </>
    )
  }

  return (
    <>
      {profileError ? <p className="auth-error">{profileError}</p> : null}
      <DashboardShell
        user={session.portalUser}
        onLogout={() => {
          void signOut(auth)
          navigate('/login')
        }}
        onSaveProfile={async (next) => {
          await saveUserProfile(session.firebaseUser.uid, {
            name: next.name,
            location: next.location,
            bio: next.bio,
            photoURL: next.photoURL,
          })
          if (next.name !== session.firebaseUser.displayName) {
            await updateProfile(session.firebaseUser, { displayName: next.name })
          }
          setProfileError(null)
        }}
        onSavePhoto={async (photoURL) => {
          await saveUserPhoto(session.firebaseUser.uid, photoURL)
          setSession({
            firebaseUser: session.firebaseUser,
            portalUser: { ...session.portalUser, photoURL },
          })
        }}
        canChangePassword={session.firebaseUser.providerData.some(
          (provider) => provider.providerId === 'password',
        )}
        onChangePassword={async (current, next) => {
          const fbUser = session.firebaseUser
          if (!fbUser.email) throw new Error('Email du compte introuvable.')
          // Réauthentification obligatoire avant une opération sensible, puis MAJ.
          const credential = EmailAuthProvider.credential(fbUser.email, current)
          await reauthenticateWithCredential(fbUser, credential)
          await updatePassword(fbUser, next)
        }}
      />
    </>
  )
}

export default function PortalApp() {
  return <FirebasePortal />
}
