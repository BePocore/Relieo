import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ArrowRight,
  BarChart3,
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
  Map,
  Menu,
  Mountain,
  Pencil,
  Plus,
  Route,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wallet,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  type User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from 'firebase/auth'
import {
  type PortalHike,
  type PortalUser,
  type ProfileExtras,
} from './portalStore'
import {
  getFirebaseAuth,
  getIdToken,
  googleProvider,
  readUserProfile,
  saveUserPhoto,
  saveUserPlan,
  saveUserProfile,
} from './firebase'
import {
  DEFAULT_PLAN_ID,
  PLANS,
  planById,
  formatBytes,
  type PlanId,
} from './plans'
import './Portal.css'

type PortalView = 'dashboard' | 'hikes' | 'profile' | 'plans'

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

const currentView = (): PortalView => {
  if (window.location.pathname.endsWith('/profile')) return 'profile'
  if (window.location.pathname.endsWith('/hikes')) return 'hikes'
  if (window.location.pathname.endsWith('/plans')) return 'plans'
  return 'dashboard'
}

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))

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

function HikeCard({ hike }: { hike: PortalHike }) {
  // Publiée → ouvre le Studio sur la rando déjà en ligne (chargée depuis Vercel).
  //   `code` identifie laquelle (ignoré tant que le backend reste mono-rando).
  // Brouillon → ouvre un Studio 3D vierge en local (`new`).
  const title = `&title=${encodeURIComponent(hike.title)}`
  const openHref =
    hike.status === 'published'
      ? `/?mode=studio&code=${encodeURIComponent(hike.code)}${title}`
      : `/?mode=studio&new=${encodeURIComponent(hike.code)}${title}`
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
          <a className="hike-open" href={openHref}>Ouvrir <ChevronRight size={16} /></a>
        </div>
      </div>
    </article>
  )
}

function ProfileView({
  user,
  onSave,
  onSavePhoto,
}: {
  user: PortalUser
  onSave: (user: PortalUser) => Promise<void>
  onSavePhoto: (photoURL: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(user)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)

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

function DashboardShell({
  user,
  onLogout,
  onSaveProfile,
  onSavePhoto,
}: {
  user: PortalUser
  onLogout: () => void
  onSaveProfile: (user: PortalUser) => Promise<void>
  onSavePhoto: (photoURL: string) => Promise<void>
}) {
  const [view, setView] = useState<PortalView>(currentView)
  const [hikes, setHikes] = useState<PortalHike[]>([])
  const [hikesError, setHikesError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [profile, setProfile] = useState(user)
  const [usage, setUsage] = useState<StorageUsage | null>(null)

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
      .then((token) => {
        if (!token) throw new Error('Connexion Firebase requise.')
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

  const setPortalView = (next: PortalView) => {
    const path = next === 'dashboard' ? '/dashboard' : `/dashboard/${next}`
    navigate(path)
    setView(next)
    setMobileMenu(false)
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

  const createHike = (title: string, code: string) => {
    setCreateOpen(false)
    window.location.assign(
      `/?mode=studio&new=${encodeURIComponent(code)}&title=${encodeURIComponent(title)}`,
    )
  }

  const saveProfile = async (next: PortalUser) => {
    await onSaveProfile(next)
    setProfile(next)
  }

  const savePhoto = async (photoURL: string) => {
    await onSavePhoto(photoURL)
    setProfile((current) => ({ ...current, photoURL }))
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
          <button type="button"><BarChart3 size={18} /> Statistiques</button>
          <button type="button"><Settings size={18} /> Paramètres</button>
        </nav>
        <div className="sidebar-status"><span><ShieldCheck size={16} /></span><div><strong>Cloud synchronisé</strong><small>Firebase + Cloudflare R2</small></div></div>
        <button className="logout-button" type="button" onClick={onLogout}><LogOut size={18} /> Déconnexion</button>
      </aside>

      <main className="portal-main">
        <header className="portal-topbar">
          <button aria-label="Menu" className="icon-button mobile-menu-button" type="button" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button>
          <label className="portal-search"><Search size={18} /><input placeholder="Rechercher une carte" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="topbar-actions"><button aria-label="Notifications" className="icon-button" type="button"><Bell size={19} /></button><button className="profile-button" type="button" onClick={() => setPortalView('profile')}><span className="profile-avatar" style={avatarStyle(profile.photoURL)}>{profile.photoURL ? '' : userInitials(profile.name)}</span><span><strong>{profile.name}</strong><small>{profile.email}</small></span></button></div>
        </header>

        <div className="portal-content">
          {view === 'profile' ? (
            <ProfileView user={profile} onSave={saveProfile} onSavePhoto={savePhoto} />
          ) : view === 'plans' ? (
            <PlansView currentPlanId={profile.plan ?? DEFAULT_PLAN_ID} />
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
                  {filteredHikes.map((hike) => <HikeCard hike={hike} key={hike.id} />)}
                  <button className="new-hike-card" type="button" onClick={() => setCreateOpen(true)}><span><Plus size={23} /></span><strong>Créer une carte</strong><small>Commencer avec un Studio 3D vierge</small></button>
                </div>
              </section>

              {view === 'dashboard' ? (
                <section className="dashboard-bottom-grid">
                  <article className="activity-panel"><div className="section-heading"><div><h2>Activité récente</h2><p>Votre dernier projet</p></div></div><div className="activity-line"><span className="activity-icon"><Mountain size={19} /></span><div><strong>Halsa a été publiée</strong><p>70 points et 66 médias synchronisés</p></div><time>{formatDate(hikes.find((hike) => hike.id === 'halsa')?.updatedAt ?? new Date().toISOString())}</time></div></article>
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

function FirebaseAuthScreen({ auth }: { auth: ReturnType<typeof getFirebaseAuth> }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const checks = passwordChecks(password)
  const passwordIsStrong = checks.every((check) => check.valid)
  const passwordsMatch = password === passwordConfirmation

  const changeMode = (nextMode: 'login' | 'signup') => {
    setMode(nextMode)
    setError(null)
    setPasswordConfirmation('')
    setShowPassword(false)
    setShowPasswordConfirmation(false)
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
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    })
  }

  return (
    <main className="portal-auth">
      <section className="auth-visual" aria-label="Présentation Relieo">
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

function FirebasePortal() {
  const auth = getFirebaseAuth()
  const [ready, setReady] = useState(false)
  const [session, setSession] = useState<{
    firebaseUser: User
    portalUser: PortalUser
  } | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)

  useEffect(() => {
    document.body.classList.add('portal-active')
    if (!auth) return () => document.body.classList.remove('portal-active')
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      if (!current) {
        setSession(null)
        setProfileError(null)
        setReady(true)
        return
      }
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
  if (!session) return <FirebaseAuthScreen auth={auth} />

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
      />
    </>
  )
}

export default function PortalApp() {
  return <FirebasePortal />
}
