import { useMemo, useState, type ReactNode } from 'react'
import {
  Bell,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  Compass,
  Eye,
  Globe,
  Heart,
  Home,
  Images,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  MapPin,
  Mountain,
  Search,
  Settings,
  Share2,
  Sparkles,
  UserPlus,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import type { PortalUser } from './portalStore'
import './Feed.css'

// ─────────────────────────────────────────────────────────────────────────────
// Coquille visuelle du réseau social (TRANCHE 1, front-only, données MOCKÉES).
// Aucun backend : likes / suivis / enregistrements sont de l'état local. Le feed
// est le nouvel écran d'accueil post-login ; le dashboard créateur reste séparé
// (`DashboardShell`), atteint via `onOpenDashboard` (créateur uniquement).
// ─────────────────────────────────────────────────────────────────────────────

type FeedView = 'feed' | 'explore' | 'following' | 'saved' | 'profile' | 'creator'

type MockCreator = {
  id: string
  name: string
  handle: string
  bio: string
  location: string
  followers: number
  following: number
  maps: number
  color: string
}

type MockPost = {
  id: string
  creatorId: string
  title: string
  location: string
  gradient: string
  views: number
  likes: number
  photos: number
  // Slug de consultation réelle (`?m=<slug>`) pour rendre la démo vivante.
  slug: string
}

// Créateurs mockés (avatars = initiales sur fond coloré).
const CREATORS: MockCreator[] = [
  {
    id: 'c1',
    name: 'Camille Vidal',
    handle: '@camille',
    bio: 'Photographe de montagne. Je cartographie mes treks en relief 3D.',
    location: 'Chamonix',
    followers: 1284,
    following: 87,
    maps: 23,
    color: '#126b47',
  },
  {
    id: 'c2',
    name: 'Léo Marchand',
    handle: '@leo',
    bio: 'Roadtrips & bivouacs. Chaque virage mérite une carte.',
    location: 'Annecy',
    followers: 642,
    following: 133,
    maps: 12,
    color: '#2a6f97',
  },
  {
    id: 'c3',
    name: 'Sofia Nkemba',
    handle: '@sofia',
    bio: 'Voyage lent, grandes traversées, photos argentiques.',
    location: 'Lisbonne',
    followers: 3510,
    following: 42,
    maps: 41,
    color: '#8a5a44',
  },
  {
    id: 'c4',
    name: 'Hugo Perret',
    handle: '@hugo',
    bio: 'Trail runner. Le D+ comme terrain de jeu.',
    location: 'Grenoble',
    followers: 908,
    following: 210,
    maps: 18,
    color: '#7048a8',
  },
]

const POSTS: MockPost[] = [
  {
    id: 'p1',
    creatorId: 'c1',
    title: 'Tour du Mont-Blanc, étape des Grands',
    location: 'Massif du Mont-Blanc',
    gradient: 'linear-gradient(135deg, #1f6f54 0%, #0b3b2c 55%, #0a2740 100%)',
    views: 4210,
    likes: 318,
    photos: 42,
    slug: 'Halsa',
  },
  {
    id: 'p2',
    creatorId: 'c3',
    title: 'Traversée des Açores en 9 jours',
    location: 'São Miguel, Açores',
    gradient: 'linear-gradient(135deg, #2a6f97 0%, #14476b 60%, #0d2233 100%)',
    views: 9120,
    likes: 742,
    photos: 88,
    slug: 'Halsa',
  },
  {
    id: 'p3',
    creatorId: 'c2',
    title: 'Roadtrip Dolomites, cols et lacs',
    location: 'Dolomites, Italie',
    gradient: 'linear-gradient(135deg, #8a5a44 0%, #5c3a2a 55%, #2a1c16 100%)',
    views: 2760,
    likes: 205,
    photos: 34,
    slug: 'Halsa',
  },
  {
    id: 'p4',
    creatorId: 'c4',
    title: 'Ultra du Vercors, 62 km',
    location: 'Vercors',
    gradient: 'linear-gradient(135deg, #4c3a7a 0%, #2f2650 55%, #171226 100%)',
    views: 1530,
    likes: 141,
    photos: 19,
    slug: 'Halsa',
  },
]

const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

const formatCount = (value: number): string =>
  value >= 1000
    ? `${(value / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`
    : String(value)

function Avatar({
  name,
  photoURL,
  color,
  size = 40,
}: {
  name: string
  photoURL?: string
  color?: string
  size?: number
}) {
  if (photoURL) {
    return (
      <img
        className="feed-avatar"
        src={photoURL}
        alt={name}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      className="feed-avatar feed-avatar-initials"
      style={{
        width: size,
        height: size,
        background: color ?? 'var(--c-accent)',
        fontSize: Math.round(size * 0.4),
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

const openMap = (slug: string): void => {
  // Consultation publique réelle d'une carte (`?m=<slug>`), pour la démo.
  window.location.assign(`/?m=${encodeURIComponent(slug)}`)
}

function PostCard({
  post,
  creator,
  liked,
  saved,
  onToggleLike,
  onToggleSave,
  onOpenCreator,
}: {
  post: MockPost
  creator: MockCreator | undefined
  liked: boolean
  saved: boolean
  onToggleLike: () => void
  onToggleSave: () => void
  onOpenCreator: () => void
}) {
  return (
    <article className="feed-post">
      <div className="feed-post-cover" style={{ backgroundImage: post.gradient }}>
        <span className="feed-post-place">
          <MapPin size={13} /> {post.location}
        </span>
        <button
          className="feed-post-open"
          type="button"
          onClick={() => openMap(post.slug)}
        >
          <MapIcon size={15} /> Ouvrir la carte 3D
        </button>
      </div>
      <div className="feed-post-body">
        <h3 className="feed-post-title">{post.title}</h3>
        <div className="feed-post-author">
          <button className="feed-author-btn" type="button" onClick={onOpenCreator}>
            <Avatar name={creator?.name ?? '?'} color={creator?.color} size={34} />
            <span>
              <strong>{creator?.name ?? 'Créateur'}</strong>
              <em>{creator?.handle}</em>
            </span>
          </button>
        </div>
        <ul className="feed-post-stats">
          <li>
            <Eye size={14} /> {formatCount(post.views)}
          </li>
          <li>
            <Heart size={14} /> {formatCount(post.likes + (liked ? 1 : 0))}
          </li>
          <li>
            <Images size={14} /> {post.photos}
          </li>
        </ul>
        <div className="feed-post-actions">
          <button
            className={`feed-action${liked ? ' active' : ''}`}
            type="button"
            onClick={onToggleLike}
          >
            <Heart size={17} fill={liked ? 'currentColor' : 'none'} /> J'aime
          </button>
          <button
            className={`feed-action${saved ? ' active' : ''}`}
            type="button"
            onClick={onToggleSave}
          >
            {saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
            {saved ? 'Enregistrée' : 'Enregistrer'}
          </button>
          <button className="feed-action" type="button">
            <Share2 size={17} /> Partager
          </button>
        </div>
      </div>
    </article>
  )
}

export default function SocialFeed({
  user,
  isCreator,
  onOpenDashboard,
  onBecomeCreator,
  onLogout,
}: {
  user: PortalUser
  isCreator: boolean
  onOpenDashboard: () => void
  // Passage viewer -> créateur : mène au choix du forfait (géré par PortalApp).
  onBecomeCreator: () => void
  onLogout: () => void
}) {
  const [view, setView] = useState<FeedView>('feed')
  const [activeCreatorId, setActiveCreatorId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // Modale d'accroche « devenir créateur » (front-only ; le vrai passage viewer
  // → créateur viendra avec un endpoint serveur, cf. tranche suivante).
  const [upsellOpen, setUpsellOpen] = useState(false)

  const openUpsell = () => {
    setUpsellOpen(true)
    setMenuOpen(false)
  }
  const [liked, setLiked] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [followed, setFollowed] = useState<Record<string, boolean>>({
    c1: true,
    c3: true,
  })

  const creatorById = useMemo(
    () => new Map(CREATORS.map((creator) => [creator.id, creator])),
    [],
  )

  const toggleLike = (id: string) =>
    setLiked((prev) => ({ ...prev, [id]: !prev[id] }))
  const toggleSave = (id: string) =>
    setSaved((prev) => ({ ...prev, [id]: !prev[id] }))
  const toggleFollow = (id: string) =>
    setFollowed((prev) => ({ ...prev, [id]: !prev[id] }))

  const openCreator = (id: string) => {
    setActiveCreatorId(id)
    setView('creator')
  }

  const go = (next: FeedView) => {
    setView(next)
    setMenuOpen(false)
  }

  const navItems: { id: FeedView; label: string; icon: ReactNode }[] = [
    { id: 'feed', label: 'Accueil', icon: <Home size={19} /> },
    { id: 'explore', label: 'Explorer', icon: <Globe size={19} /> },
    { id: 'following', label: 'Créateurs suivis', icon: <Users size={19} /> },
    { id: 'saved', label: 'Enregistrées', icon: <Bookmark size={19} /> },
  ]

  const savedPosts = POSTS.filter((post) => saved[post.id])
  const followingPosts = POSTS.filter((post) => followed[post.creatorId])
  const suggestions = CREATORS.filter((creator) => !followed[creator.id])

  const renderPosts = (posts: MockPost[], emptyLabel: string) =>
    posts.length ? (
      <div className="feed-list">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            creator={creatorById.get(post.creatorId)}
            liked={Boolean(liked[post.id])}
            saved={Boolean(saved[post.id])}
            onToggleLike={() => toggleLike(post.id)}
            onToggleSave={() => toggleSave(post.id)}
            onOpenCreator={() => openCreator(post.creatorId)}
          />
        ))}
      </div>
    ) : (
      <div className="feed-empty">
        <Mountain size={30} />
        <p>{emptyLabel}</p>
      </div>
    )

  const renderCenter = () => {
    if (view === 'creator') {
      const creator = activeCreatorId ? creatorById.get(activeCreatorId) : undefined
      if (!creator) return null
      const creatorPosts = POSTS.filter((post) => post.creatorId === creator.id)
      return (
        <CreatorProfile
          creator={creator}
          followed={Boolean(followed[creator.id])}
          onToggleFollow={() => toggleFollow(creator.id)}
          posts={creatorPosts}
          onOpenMap={openMap}
        />
      )
    }
    if (view === 'profile') {
      return (
        <OwnProfile
          user={user}
          isCreator={isCreator}
          onOpenDashboard={onOpenDashboard}
          onOpenUpsell={openUpsell}
        />
      )
    }
    if (view === 'explore') {
      return (
        <>
          <h2 className="feed-section-title"><Globe size={18} /> Explorer</h2>
          {renderPosts(POSTS, 'Rien à explorer pour l’instant.')}
        </>
      )
    }
    if (view === 'following') {
      return (
        <>
          <h2 className="feed-section-title"><Users size={18} /> Créateurs suivis</h2>
          {renderPosts(
            followingPosts,
            'Tu ne suis encore personne. Explore pour trouver des créateurs.',
          )}
        </>
      )
    }
    if (view === 'saved') {
      return (
        <>
          <h2 className="feed-section-title"><Bookmark size={18} /> Enregistrées</h2>
          {renderPosts(savedPosts, 'Aucune carte enregistrée pour le moment.')}
        </>
      )
    }
    return renderPosts(POSTS, 'Ton feed est vide.')
  }

  return (
    <div className="feed-shell">
      <header className="feed-header">
        <div className="feed-brand">
          <span className="portal-logo"><Compass size={22} /></span>
          <strong>Relieo</strong>
        </div>
        <label className="feed-search">
          <Search size={17} />
          <input type="search" placeholder="Rechercher une carte, un créateur…" />
        </label>
        <div className="feed-header-right">
          <button className="feed-icon-btn" type="button" aria-label="Notifications">
            <Bell size={20} />
            <span className="feed-dot" />
          </button>
          <div className="feed-menu-wrap">
            <button
              className="feed-avatar-btn"
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Avatar name={user.name} photoURL={user.photoURL} size={38} />
              <ChevronDown size={15} />
            </button>
            {menuOpen ? (
              <div className="feed-menu" role="menu">
                <div className="feed-menu-head">
                  <strong>{user.name}</strong>
                  <span>{isCreator ? 'Créateur' : 'Viewer'}</span>
                </div>
                <button role="menuitem" type="button" onClick={() => go('profile')}>
                  <UserRound size={16} /> Mon profil
                </button>
                {isCreator ? null : (
                  <button
                    role="menuitem"
                    className="feed-menu-upsell"
                    type="button"
                    onClick={openUpsell}
                  >
                    <Sparkles size={16} /> Devenir créateur
                  </button>
                )}
                {isCreator ? (
                  <>
                    <button
                      role="menuitem"
                      type="button"
                      onClick={onOpenDashboard}
                    >
                      <LayoutDashboard size={16} /> Dashboard créateur
                    </button>
                    <button
                      role="menuitem"
                      type="button"
                      onClick={onOpenDashboard}
                    >
                      <Settings size={16} /> Paramètres
                    </button>
                  </>
                ) : null}
                <button
                  role="menuitem"
                  className="feed-menu-danger"
                  type="button"
                  onClick={onLogout}
                >
                  <LogOut size={16} /> Déconnexion
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="feed-body">
        <nav className="feed-nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`feed-nav-item${view === item.id ? ' active' : ''}`}
              type="button"
              onClick={() => go(item.id)}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </nav>

        <main className="feed-main">{renderCenter()}</main>

        <aside className="feed-aside">
          <section className="feed-card">
            <h3><UserPlus size={16} /> Créateurs à suivre</h3>
            <ul className="feed-suggest">
              {suggestions.map((creator) => (
                <li key={creator.id}>
                  <button
                    className="feed-suggest-user"
                    type="button"
                    onClick={() => openCreator(creator.id)}
                  >
                    <Avatar name={creator.name} color={creator.color} size={38} />
                    <span>
                      <strong>{creator.name}</strong>
                      <em>{formatCount(creator.followers)} abonnés</em>
                    </span>
                  </button>
                  <button
                    className={`feed-follow${followed[creator.id] ? ' following' : ''}`}
                    type="button"
                    onClick={() => toggleFollow(creator.id)}
                  >
                    {followed[creator.id] ? <Check size={14} /> : null}
                    {followed[creator.id] ? 'Suivi' : 'Suivre'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="feed-card">
            <h3><MapPin size={16} /> Près de chez toi</h3>
            <ul className="feed-nearby">
              <li><Mountain size={15} /> Pyrénées ariégeoises</li>
              <li><Mountain size={15} /> Canal du Midi à vélo</li>
              <li><Mountain size={15} /> Gorges du Tarn</li>
            </ul>
          </section>
        </aside>
      </div>

      <nav className="feed-tabbar">
        <button className={view === 'feed' ? 'active' : ''} type="button" onClick={() => go('feed')}>
          <Home size={20} /><span>Accueil</span>
        </button>
        <button className={view === 'explore' ? 'active' : ''} type="button" onClick={() => go('explore')}>
          <Globe size={20} /><span>Explorer</span>
        </button>
        <button className={view === 'saved' ? 'active' : ''} type="button" onClick={() => go('saved')}>
          <Bookmark size={20} /><span>Enregistrées</span>
        </button>
        <button className={view === 'profile' ? 'active' : ''} type="button" onClick={() => go('profile')}>
          <UserRound size={20} /><span>Profil</span>
        </button>
      </nav>

      {upsellOpen ? (
        <div
          className="feed-upsell-backdrop"
          role="presentation"
          onMouseDown={() => setUpsellOpen(false)}
        >
          <div
            className="feed-upsell"
            role="dialog"
            aria-modal="true"
            aria-label="Devenir créateur"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="feed-upsell-close"
              type="button"
              aria-label="Fermer"
              onClick={() => setUpsellOpen(false)}
            >
              <X size={18} />
            </button>
            <span className="feed-upsell-badge"><Sparkles size={22} /></span>
            <h2>Deviens créateur</h2>
            <p className="feed-upsell-sub">
              Passe de spectateur à créateur et partage tes propres aventures.
            </p>
            <ul className="feed-upsell-perks">
              <li>
                <MapIcon size={18} /> Publie tes cartes en relief 3D
              </li>
              <li>
                <Users size={18} /> Un profil public, des abonnés
              </li>
              <li>
                <LayoutDashboard size={18} /> Ton dashboard créateur
              </li>
            </ul>
            <button
              className="feed-upsell-cta"
              type="button"
              onClick={() => {
                setUpsellOpen(false)
                onBecomeCreator()
              }}
            >
              Choisir mon forfait
            </button>
            <p className="feed-upsell-note">
              Forfait Standard gratuit. Les offres payantes arrivent bientôt.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function CreatorProfile({
  creator,
  followed,
  onToggleFollow,
  posts,
  onOpenMap,
}: {
  creator: MockCreator
  followed: boolean
  onToggleFollow: () => void
  posts: MockPost[]
  onOpenMap: (slug: string) => void
}) {
  return (
    <div className="feed-profile">
      <div className="feed-profile-banner" style={{ backgroundImage: 'linear-gradient(120deg, #126b47, #0b3b2c 60%, #0a2740)' }} />
      <div className="feed-profile-head">
        <Avatar name={creator.name} color={creator.color} size={92} />
        <div className="feed-profile-id">
          <h2>
            {creator.name}
            <span className="feed-badge">Créateur</span>
          </h2>
          <p className="feed-profile-bio">{creator.bio}</p>
          <p className="feed-profile-loc"><MapPin size={14} /> {creator.location}</p>
        </div>
        <button
          className={`feed-follow big${followed ? ' following' : ''}`}
          type="button"
          onClick={onToggleFollow}
        >
          {followed ? <Check size={15} /> : <UserPlus size={15} />}
          {followed ? 'Suivi' : 'Suivre'}
        </button>
      </div>
      <ul className="feed-profile-counters">
        <li><strong>{formatCount(creator.followers)}</strong> abonnés</li>
        <li><strong>{creator.following}</strong> abonnements</li>
        <li><strong>{creator.maps}</strong> cartes</li>
      </ul>
      <div className="feed-grid">
        {posts.map((post) => (
          <button
            key={post.id}
            className="feed-grid-card"
            type="button"
            onClick={() => onOpenMap(post.slug)}
          >
            <span className="feed-grid-cover" style={{ backgroundImage: post.gradient }} />
            <span className="feed-grid-title">{post.title}</span>
            <span className="feed-grid-meta"><Eye size={12} /> {formatCount(post.views)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function OwnProfile({
  user,
  isCreator,
  onOpenDashboard,
  onOpenUpsell,
}: {
  user: PortalUser
  isCreator: boolean
  onOpenDashboard: () => void
  onOpenUpsell: () => void
}) {
  return (
    <div className="feed-profile">
      <div className="feed-profile-banner" style={{ backgroundImage: 'linear-gradient(120deg, #2a6f97, #14476b 60%, #0d2233)' }} />
      <div className="feed-profile-head">
        <Avatar name={user.name} photoURL={user.photoURL} size={92} />
        <div className="feed-profile-id">
          <h2>
            {user.name}
            <span className="feed-badge">{isCreator ? 'Créateur' : 'Viewer'}</span>
          </h2>
          <p className="feed-profile-bio">{user.bio || 'Aucune bio pour l’instant.'}</p>
          {user.location ? (
            <p className="feed-profile-loc"><MapPin size={14} /> {user.location}</p>
          ) : null}
        </div>
        {isCreator ? (
          <button className="feed-follow big" type="button" onClick={onOpenDashboard}>
            <LayoutDashboard size={15} /> Dashboard créateur
          </button>
        ) : null}
      </div>
      {isCreator ? null : (
        <div className="feed-empty feed-become">
          <Mountain size={30} />
          <p>Tu es viewer : tu suis des créateurs et enregistres leurs cartes.</p>
          <button className="feed-become-creator" type="button" onClick={onOpenUpsell}>
            <Sparkles size={16} /> Devenir créateur
          </button>
        </div>
      )}
    </div>
  )
}
