import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  ArrowRight,
  BarChart3,
  Bell,
  Camera,
  Check,
  ChevronRight,
  CircleUserRound,
  Compass,
  FolderKanban,
  Gauge,
  Image,
  KeyRound,
  LayoutDashboard,
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
  UserRound,
  X,
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
  endSession,
  hashPassword,
  hasSession,
  readHikesForOwner,
  readProfileExtras,
  readUser,
  resetHikes,
  saveHikesForOwner,
  saveProfileExtras,
  saveUser,
  startSession,
  type PortalHike,
  type PortalUser,
} from './portalStore'
import { firebaseEnabled, getFirebaseAuth, googleProvider } from './firebase'
import './Portal.css'

type PortalView = 'dashboard' | 'hikes' | 'profile'

// Entrée du registre serveur (api/hikes). Source de vérité pour l'existence et
// les stats d'une rando ; fusionnée avec le cache localStorage.
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

// Fusionne les randos du backend (par code) dans la liste locale.
const mergeBackendHikes = (
  local: PortalHike[],
  backend: BackendHike[],
  ownerId: string,
): PortalHike[] => {
  // `Map` est importé comme icône lucide → on vise explicitement le Map JS.
  const byCode = new globalThis.Map<string, PortalHike>(
    local.map((hike) => [hike.code, hike]),
  )
  for (const entry of backend) {
    const existing = byCode.get(entry.code)
    byCode.set(entry.code, {
      id: existing?.id ?? entry.code,
      ownerId: entry.ownerId || ownerId,
      title: entry.title || existing?.title || entry.code,
      code: entry.code,
      status: entry.status,
      distanceKm: entry.distanceKm,
      elevationGain: entry.elevationGain,
      mediaCount: entry.mediaCount,
      pointCount: entry.pointCount,
      updatedAt: entry.updatedAt,
      coverUrl: entry.coverUrl ?? existing?.coverUrl,
    })
  }
  return Array.from(byCode.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )
}

const navigate = (path: string): void => {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const currentView = (): PortalView => {
  if (window.location.pathname.endsWith('/profile')) return 'profile'
  if (window.location.pathname.endsWith('/hikes')) return 'hikes'
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

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>(() =>
    readUser() ? 'login' : 'signup',
  )
  const [name, setName] = useState('Quentin')
  const [email, setEmail] = useState(() => readUser()?.email ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const normalizedEmail = email.trim().toLowerCase()
      if (!normalizedEmail || password.length < 8) {
        throw new Error('Utilise une adresse email et un mot de passe de 8 caractères minimum.')
      }
      const passwordHash = await hashPassword(password)
      if (mode === 'signup') {
        const user: PortalUser = {
          id: crypto.randomUUID(),
          name: name.trim() || 'Randonneur',
          email: normalizedEmail,
          passwordHash,
          location: 'France',
          bio: 'Je transforme mes randonnées en récits cartographiques 3D.',
          createdAt: new Date().toISOString(),
        }
        resetHikes(user.id)
        saveUser(user)
        startSession(user)
      } else {
        const user = readUser()
        if (
          !user ||
          user.email.toLowerCase() !== normalizedEmail ||
          user.passwordHash !== passwordHash
        ) {
          throw new Error('Email ou mot de passe incorrect.')
        }
        startSession(user)
      }
      onAuthenticated()
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Connexion impossible.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="portal-auth">
      <section className="auth-visual" aria-label="Présentation Randonnée 3D">
        <div className="auth-brand">
          <span className="portal-logo"><Compass size={24} /></span>
          <strong>Randonnée 3D</strong>
        </div>
        <div className="auth-visual-copy">
          <p className="portal-kicker">Votre carnet cartographique</p>
          <h1>Retrouvez chaque randonnée, chaque image, au bon endroit.</h1>
          <div className="auth-proof">
            <span><Mountain size={17} /> Relief 3D</span>
            <span><Camera size={17} /> Médias géolocalisés</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-form-wrap">
          <span className="prototype-label">Prototype local</span>
          <h2>{mode === 'signup' ? 'Créer votre espace' : 'Bon retour parmi nous'}</h2>
          <p>
            {mode === 'signup'
              ? 'Préparez votre bibliothèque de randonnées.'
              : 'Connectez-vous à votre tableau de bord.'}
          </p>
          <div className="auth-switch" role="tablist" aria-label="Authentification">
            <button
              className={mode === 'login' ? 'active' : ''}
              role="tab"
              type="button"
              onClick={() => setMode('login')}
            >
              Connexion
            </button>
            <button
              className={mode === 'signup' ? 'active' : ''}
              role="tab"
              type="button"
              onClick={() => setMode('signup')}
            >
              Inscription
            </button>
          </div>
          <form className="auth-form" onSubmit={submit}>
            {mode === 'signup' ? (
              <label>
                <span>Nom</span>
                <div className="input-shell"><UserRound size={17} /><input value={name} onChange={(event) => setName(event.target.value)} /></div>
              </label>
            ) : null}
            <label>
              <span>Email</span>
              <div className="input-shell"><CircleUserRound size={17} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            </label>
            <label>
              <span>Mot de passe</span>
              <div className="input-shell"><KeyRound size={17} /><input minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
            </label>
            {error ? <p className="auth-error">{error}</p> : null}
            <button className="portal-primary auth-submit" disabled={busy} type="submit">
              {busy ? 'Vérification...' : mode === 'signup' ? 'Créer mon espace' : 'Se connecter'}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-note">
            Cette authentification fonctionne uniquement sur cet ordinateur pendant le prototype.
          </p>
        </div>
      </section>
    </main>
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
        <h2 id="create-hike-title">Nouvelle randonnée</h2>
        <p>Un Studio 3D vierge sera préparé avec ce code.</p>
        <label>
          <span>Nom de la randonnée</span>
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
          <Plus size={17} /> Créer la randonnée
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

function ProfileView({ user, onSave }: { user: PortalUser; onSave: (user: PortalUser) => void }) {
  const [draft, setDraft] = useState(user)
  const [saved, setSaved] = useState(false)
  return (
    <section className="profile-view">
      <header className="page-heading">
        <div><p className="portal-kicker">Compte</p><h1>Votre profil</h1><p>Les informations qui accompagneront vos randonnées.</p></div>
      </header>
      <div className="profile-layout">
        <div className="profile-identity">
          <span className="profile-avatar large">{userInitials(draft.name)}</span>
          <h2>{draft.name}</h2><p>{draft.email}</p>
          <span className="profile-security"><ShieldCheck size={15} /> Profil local protégé</span>
        </div>
        <form className="profile-form" onSubmit={(event) => { event.preventDefault(); onSave(draft); setSaved(true) }}>
          <label><span>Nom complet</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>Email</span><input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
          <label><span>Localisation</span><input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
          <label className="profile-bio"><span>Présentation</span><textarea rows={4} value={draft.bio} onChange={(event) => setDraft({ ...draft, bio: event.target.value })} /></label>
          <button className="portal-primary" type="submit">{saved ? <Check size={17} /> : <UserRound size={17} />}{saved ? 'Profil enregistré' : 'Enregistrer le profil'}</button>
        </form>
      </div>
    </section>
  )
}

function DashboardShell({
  user,
  onLogout,
  onSaveProfile = saveUser,
}: {
  user: PortalUser
  onLogout: () => void
  onSaveProfile?: (user: PortalUser) => void
}) {
  const [view, setView] = useState<PortalView>(currentView)
  // Le dashboard ne montre que les randos dont l'utilisateur est propriétaire.
  const [hikes, setHikes] = useState<PortalHike[]>(() =>
    readHikesForOwner(user.id),
  )
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState(false)
  const [profile, setProfile] = useState(user)

  useEffect(() => {
    const syncView = () => setView(currentView())
    window.addEventListener('popstate', syncView)
    return () => window.removeEventListener('popstate', syncView)
  }, [])

  // Récupère les randos réelles du backend (api/hikes) et les fusionne dans le
  // cache local. En l'absence de backend (vite seul) on garde le localStorage.
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch(`/api/hikes?ownerId=${encodeURIComponent(user.id)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { hikes?: BackendHike[] } | null) => {
        if (cancelled || !data?.hikes?.length) return
        setHikes((current) => {
          const merged = mergeBackendHikes(current, data.hikes!, user.id)
          saveHikesForOwner(user.id, merged)
          return merged
        })
      })
      .catch(() => {})
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
    const hike: PortalHike = {
      id: crypto.randomUUID(),
      ownerId: user.id,
      title,
      code,
      status: 'draft',
      distanceKm: 0,
      elevationGain: 0,
      mediaCount: 0,
      pointCount: 0,
      updatedAt: new Date().toISOString(),
    }
    const next = [hike, ...hikes]
    setHikes(next)
    saveHikesForOwner(user.id, next)
    setCreateOpen(false)
    window.location.assign(`/?mode=studio&new=${encodeURIComponent(code)}`)
  }

  const saveProfile = (next: PortalUser) => {
    setProfile(next)
    onSaveProfile(next)
  }

  return (
    <div className="portal-shell">
      <aside className={mobileMenu ? 'portal-sidebar open' : 'portal-sidebar'}>
        <div className="sidebar-brand"><span className="portal-logo"><Compass size={22} /></span><strong>Randonnée 3D</strong></div>
        <nav aria-label="Navigation principale">
          <p>ESPACE</p>
          <button className={view === 'dashboard' ? 'active' : ''} type="button" onClick={() => setPortalView('dashboard')}><LayoutDashboard size={18} /> Vue d’ensemble</button>
          <button className={view === 'hikes' ? 'active' : ''} type="button" onClick={() => setPortalView('hikes')}><Map size={18} /> Mes randonnées <span>{hikes.length}</span></button>
          <button className={view === 'profile' ? 'active' : ''} type="button" onClick={() => setPortalView('profile')}><UserRound size={18} /> Mon profil</button>
          <p>OUTILS</p>
          <button type="button"><BarChart3 size={18} /> Statistiques</button>
          <button type="button"><Settings size={18} /> Paramètres</button>
        </nav>
        <div className="sidebar-status"><span><ShieldCheck size={16} /></span><div><strong>Prototype local</strong><small>Aucune donnée envoyée</small></div></div>
        <button className="logout-button" type="button" onClick={onLogout}><LogOut size={18} /> Déconnexion</button>
      </aside>

      <main className="portal-main">
        <header className="portal-topbar">
          <button aria-label="Menu" className="icon-button mobile-menu-button" type="button" onClick={() => setMobileMenu(!mobileMenu)}><Menu size={20} /></button>
          <label className="portal-search"><Search size={18} /><input placeholder="Rechercher une randonnée" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="topbar-actions"><button aria-label="Notifications" className="icon-button" type="button"><Bell size={19} /></button><button className="profile-button" type="button" onClick={() => setPortalView('profile')}><span className="profile-avatar">{userInitials(profile.name)}</span><span><strong>{profile.name}</strong><small>{profile.email}</small></span></button></div>
        </header>

        <div className="portal-content">
          {view === 'profile' ? (
            <ProfileView user={profile} onSave={saveProfile} />
          ) : (
            <>
              <header className="page-heading">
                <div><p className="portal-kicker">{view === 'hikes' ? 'Bibliothèque' : 'Tableau de bord'}</p><h1>{view === 'hikes' ? 'Toutes vos randonnées' : `Bonjour ${profile.name.split(' ')[0]}`}</h1><p>{view === 'hikes' ? 'Retrouvez les projets publiés et les brouillons.' : 'Votre espace personnel pour créer et raconter vos parcours.'}</p></div>
                <button className="portal-primary" type="button" onClick={() => setCreateOpen(true)}><Plus size={18} /> Nouvelle randonnée</button>
              </header>

              {view === 'dashboard' ? (
                <section className="summary-grid" aria-label="Résumé">
                  <article className="summary-card featured"><span><FolderKanban size={19} /></span><p>Randonnées</p><strong>{hikes.length}</strong><small>{hikes.filter((hike) => hike.status === 'published').length} publiée</small></article>
                  <article className="summary-card"><span><Route size={19} /></span><p>Distance totale</p><strong>{totals.distance.toLocaleString('fr-FR')} km</strong><small>sur tous vos parcours</small></article>
                  <article className="summary-card"><span><Gauge size={19} /></span><p>Dénivelé cumulé</p><strong>{totals.gain.toLocaleString('fr-FR')} m</strong><small>de montée enregistrée</small></article>
                  <article className="summary-card"><span><Image size={19} /></span><p>Médias</p><strong>{totals.media}</strong><small>photos et vidéos</small></article>
                </section>
              ) : null}

              <section className="hikes-section">
                <div className="section-heading"><div><h2>{view === 'hikes' ? 'Bibliothèque' : 'Randonnées récentes'}</h2><p>{filteredHikes.length} projet{filteredHikes.length > 1 ? 's' : ''}</p></div>{view === 'dashboard' ? <button type="button" onClick={() => setPortalView('hikes')}>Tout afficher <ChevronRight size={16} /></button> : null}</div>
                <div className="hikes-grid">
                  {filteredHikes.map((hike) => <HikeCard hike={hike} key={hike.id} />)}
                  <button className="new-hike-card" type="button" onClick={() => setCreateOpen(true)}><span><Plus size={23} /></span><strong>Créer une randonnée</strong><small>Commencer avec un Studio 3D vierge</small></button>
                </div>
              </section>

              {view === 'dashboard' ? (
                <section className="dashboard-bottom-grid">
                  <article className="activity-panel"><div className="section-heading"><div><h2>Activité récente</h2><p>Votre dernier projet</p></div></div><div className="activity-line"><span className="activity-icon"><Mountain size={19} /></span><div><strong>Halsa a été publiée</strong><p>70 points et 66 médias synchronisés</p></div><time>{formatDate(hikes.find((hike) => hike.id === 'halsa')?.updatedAt ?? new Date().toISOString())}</time></div></article>
                  <article className="storage-panel"><div><p className="portal-kicker">Stockage média</p><h2>Cloudflare R2</h2><p>Vos originaux restent centralisés et accessibles en qualité maximale.</p></div><div className="storage-meter"><span style={{ width: '26%' }} /></div><div className="storage-legend"><strong>2,55 Go utilisés</strong><span>Limite 9,99 Go</span></div></article>
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
const toPortalUser = (fb: User): PortalUser => {
  const extras = readProfileExtras(fb.uid)
  return {
    id: fb.uid,
    name:
      extras.name || fb.displayName || fb.email?.split('@')[0] || 'Randonneur',
    email: fb.email ?? '',
    passwordHash: '',
    location: extras.location ?? 'France',
    bio:
      extras.bio ?? 'Je transforme mes randonnées en récits cartographiques 3D.',
    createdAt: fb.metadata.creationTime ?? new Date().toISOString(),
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
      return 'Mot de passe trop faible (6 caractères minimum).'
    case 'auth/popup-closed-by-user':
      return 'Connexion Google annulée.'
    default:
      return error instanceof Error ? error.message : 'Connexion impossible.'
  }
}

function FirebaseAuthScreen({ auth }: { auth: ReturnType<typeof getFirebaseAuth> }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    })
  }

  return (
    <main className="portal-auth">
      <section className="auth-visual" aria-label="Présentation Randonnée 3D">
        <div className="auth-brand">
          <span className="portal-logo"><Compass size={24} /></span>
          <strong>Randonnée 3D</strong>
        </div>
        <div className="auth-visual-copy">
          <p className="portal-kicker">Votre carnet cartographique</p>
          <h1>Retrouvez chaque randonnée, chaque image, au bon endroit.</h1>
          <div className="auth-proof">
            <span><Mountain size={17} /> Relief 3D</span>
            <span><Camera size={17} /> Médias géolocalisés</span>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-form-wrap">
          <h2>{mode === 'signup' ? 'Créer votre espace' : 'Bon retour parmi nous'}</h2>
          <p>Connectez-vous pour retrouver vos randonnées 3D.</p>

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
            <button className={mode === 'login' ? 'active' : ''} role="tab" type="button" onClick={() => setMode('login')}>Connexion</button>
            <button className={mode === 'signup' ? 'active' : ''} role="tab" type="button" onClick={() => setMode('signup')}>Inscription</button>
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
              <div className="input-shell"><CircleUserRound size={17} /><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            </label>
            <label>
              <span>Mot de passe</span>
              <div className="input-shell"><KeyRound size={17} /><input minLength={6} type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
            </label>
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
  const [fbUser, setFbUser] = useState<User | null>(null)

  useEffect(() => {
    document.body.classList.add('portal-active')
    if (!auth) {
      setReady(true)
      return () => document.body.classList.remove('portal-active')
    }
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      setFbUser(current)
      setReady(true)
    })
    return () => {
      document.body.classList.remove('portal-active')
      unsubscribe()
    }
  }, [auth])

  if (!ready) return null
  if (!fbUser) return <FirebaseAuthScreen auth={auth} />

  const portalUser = toPortalUser(fbUser)
  return (
    <DashboardShell
      user={portalUser}
      onLogout={() => {
        if (auth) void signOut(auth)
        navigate('/login')
      }}
      onSaveProfile={(next) =>
        saveProfileExtras(fbUser.uid, {
          name: next.name,
          location: next.location,
          bio: next.bio,
        })
      }
    />
  )
}

// Fallback prototype (auth localStorage) tant que Firebase n'est pas configuré.
function LocalPortal() {
  const [authenticated, setAuthenticated] = useState(hasSession)
  const [user, setUser] = useState<PortalUser | null>(readUser)

  useEffect(() => {
    document.body.classList.add('portal-active')
    return () => document.body.classList.remove('portal-active')
  }, [])

  if (!authenticated || !user) {
    return (
      <AuthScreen
        onAuthenticated={() => {
          setUser(readUser())
          setAuthenticated(true)
          navigate('/dashboard')
        }}
      />
    )
  }

  return (
    <DashboardShell
      user={user}
      onLogout={() => {
        endSession()
        setAuthenticated(false)
        navigate('/login')
      }}
    />
  )
}

export default function PortalApp() {
  return firebaseEnabled ? <FirebasePortal /> : <LocalPortal />
}
