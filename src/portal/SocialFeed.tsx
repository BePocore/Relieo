import { useEffect, useState, type ReactNode } from 'react'
import {
  Bell,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  Compass,
  Globe,
  Heart,
  Home,
  Images,
  LayoutDashboard,
  Lock,
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
import {
  fetchContext,
  fetchCreator,
  fetchExplore,
  fetchFeed,
  fetchSaved,
  fetchSearch,
  fetchSuggestions,
  followCreator,
  likeMap,
  saveMap,
  unfollowCreator,
  unlikeMap,
  unsaveMap,
  type SocialCard,
  type SocialCreator,
} from './socialApi'
import './Feed.css'

// ─────────────────────────────────────────────────────────────────────────────
// Réseau social (TRANCHE 1) branché sur de VRAIES données via `/api/social` :
// feed « Accueil » (créateurs suivis, repli populaires), Explorer (toutes les
// cartes publiques), profils créateurs réels, suivis persistés, pseudos uniques.
// Likes / enregistrements restent locaux (persistés en tranche 2). Le dashboard
// créateur reste séparé (`DashboardShell`), atteint via `onOpenDashboard`.
// ─────────────────────────────────────────────────────────────────────────────

type FeedView = 'feed' | 'explore' | 'following' | 'saved' | 'creator'

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

// Couleur d'avatar déterministe (initiales) et dégradé de couverture provisoire
// dérivés d'un identifiant : chaque créateur / carte a une teinte stable tant
// que les vraies photos de couverture ne sont pas servies (tranche dédiée).
const hashString = (value: string): number => {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}
const colorFromId = (id: string): string => `hsl(${hashString(id) % 360} 42% 40%)`
const gradientFromSlug = (slug: string): string => {
  const hash = hashString(slug)
  return `linear-gradient(135deg, hsl(${hash % 360} 46% 30%), hsl(${(hash >> 4) % 360} 42% 16%))`
}

const formatKm = (km: number): string | null =>
  km > 0 ? `${km.toFixed(km < 10 ? 1 : 0)} km` : null
const formatGain = (m: number): string | null => (m > 0 ? `+${Math.round(m)} m` : null)

const openMap = (slug: string): void => {
  window.location.assign(`/?m=${encodeURIComponent(slug)}`)
}

// Renvoie une NOUVELLE Set avec `key` ajoutée ou retirée (immuable, pour setState).
const toggleInSet = (set: Set<string>, key: string, present: boolean): Set<string> => {
  const next = new Set(set)
  if (present) next.add(key)
  else next.delete(key)
  return next
}

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

function PostCard({
  card,
  liked,
  saved,
  likeCount,
  onToggleLike,
  onToggleSave,
  onOpenCreator,
}: {
  card: SocialCard
  liked: boolean
  saved: boolean
  likeCount: number
  onToggleLike: () => void
  onToggleSave: () => void
  onOpenCreator: () => void
}) {
  const author = card.author
  const stats = [formatKm(card.distanceKm), formatGain(card.elevationGain)].filter(Boolean)
  return (
    <article className="feed-post">
      <div
        className="feed-post-cover"
        style={{ backgroundImage: gradientFromSlug(card.slug) }}
      >
        {stats.length ? (
          <span className="feed-post-place">
            <Mountain size={13} /> {stats.join(' · ')}
          </span>
        ) : null}
        {card.protected ? (
          <span className="feed-post-lock">
            <Lock size={12} /> Code requis
          </span>
        ) : null}
        <button
          className="feed-post-open"
          type="button"
          onClick={() => openMap(card.slug)}
        >
          <MapIcon size={15} /> Ouvrir la carte 3D
        </button>
      </div>
      <div className="feed-post-body">
        <h3 className="feed-post-title">{card.title}</h3>
        <div className="feed-post-author">
          <button className="feed-author-btn" type="button" onClick={onOpenCreator}>
            <Avatar
              name={author.name}
              photoURL={author.photoURL}
              color={colorFromId(author.uid)}
              size={34}
            />
            <span>
              <strong>{author.name}</strong>
              <em>{author.handle ? `@${author.handle}` : 'Créateur'}</em>
            </span>
          </button>
        </div>
        <ul className="feed-post-stats">
          <li>
            <Heart size={14} /> {formatCount(likeCount)}
          </li>
          <li>
            <Images size={14} /> {card.mediaCount}
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
  onOpenProfile,
  onBecomeCreator,
  onLogout,
}: {
  user: PortalUser
  isCreator: boolean
  onOpenDashboard: () => void
  // « Mon profil » : navigue vers l'écran de compte partagé (/profile), le même
  // pour tous (créateur → profil du dashboard, viewer → écran de compte).
  onOpenProfile: () => void
  onBecomeCreator: () => void
  onLogout: () => void
}) {
  const [view, setView] = useState<FeedView>('feed')
  const [menuOpen, setMenuOpen] = useState(false)
  const [upsellOpen, setUpsellOpen] = useState(false)

  const [following, setFollowing] = useState<Set<string>>(new Set())
  const [feed, setFeed] = useState<SocialCard[] | null>(null)
  const [explore, setExplore] = useState<SocialCard[] | null>(null)
  const [suggestions, setSuggestions] = useState<SocialCreator[]>([])
  const [creatorData, setCreatorData] = useState<
    { creator: SocialCreator; cards: SocialCard[]; following: boolean } | null
  >(null)
  const [creatorLoading, setCreatorLoading] = useState(false)

  const [liked, setLiked] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const [savedCards, setSavedCards] = useState<SocialCard[] | null>(null)

  // Recherche : requête + résultats (cartes publiées, code inclus + créateurs).
  // Les résultats portent la requête à laquelle ils répondent (`q`) : tant
  // qu'elle ne correspond pas à la saisie courante, on affiche « Chargement ».
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<
    { q: string; maps: SocialCard[]; creators: SocialCreator[] } | null
  >(null)

  // Chargement initial : contexte (suivis + likes + enregistrements), feed et
  // suggestions. Toléré en échec (ex. `npm run dev` sans backend) → états vides.
  useEffect(() => {
    let alive = true
    fetchContext()
      .then((ctx) => {
        if (!alive) return
        setFollowing(new Set(ctx.following))
        setLiked(new Set(ctx.liked))
        setSaved(new Set(ctx.saved))
      })
      .catch(() => {})
    fetchFeed()
      .then((cards) => alive && setFeed(cards))
      .catch(() => alive && setFeed([]))
    fetchSuggestions()
      .then((creators) => alive && setSuggestions(creators))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Explorer (et « suivis », qui filtre l'explore) : chargé à la demande.
  useEffect(() => {
    if ((view === 'explore' || view === 'following') && explore === null) {
      let alive = true
      fetchExplore()
        .then((cards) => alive && setExplore(cards))
        .catch(() => alive && setExplore([]))
      return () => {
        alive = false
      }
    }
    return undefined
  }, [view, explore])

  // Onglet « Enregistrées » : cartes réelles, rechargées à chaque ouverture.
  useEffect(() => {
    if (view !== 'saved') return undefined
    let alive = true
    fetchSaved()
      .then((cards) => alive && setSavedCards(cards))
      .catch(() => alive && setSavedCards([]))
    return () => {
      alive = false
    }
  }, [view])

  // Recherche (anti-rebond) : cartes publiées (code inclus) + créateurs. Tous
  // les setState sont dans le callback différé (jamais en direct dans l'effet).
  useEffect(() => {
    const q = query.trim()
    const timer = setTimeout(() => {
      if (q.length < 2) {
        setSearchResults(null)
        return
      }
      fetchSearch(q)
        .then((results) => setSearchResults({ q, ...results }))
        .catch(() => setSearchResults({ q, maps: [], creators: [] }))
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const openUpsell = () => {
    setUpsellOpen(true)
    setMenuOpen(false)
  }

  // Applique un delta au compteur de likes d'une carte dans TOUTES les listes
  // chargées (feed, explore, enregistrées, profil), pour un affichage cohérent.
  const bumpLike = (slug: string, delta: number) => {
    const patch = (cards: SocialCard[] | null) =>
      cards
        ? cards.map((card) =>
            card.slug === slug
              ? { ...card, likeCount: Math.max(0, card.likeCount + delta) }
              : card,
          )
        : cards
    setFeed(patch)
    setExplore(patch)
    setSavedCards(patch)
    setCreatorData((prev) =>
      prev ? { ...prev, cards: patch(prev.cards) ?? prev.cards } : prev,
    )
  }

  // Like / enregistrement persistés : bascule optimiste, revert si l'appel échoue.
  const toggleLike = async (slug: string) => {
    const wasLiked = liked.has(slug)
    setLiked((prev) => toggleInSet(prev, slug, !wasLiked))
    bumpLike(slug, wasLiked ? -1 : 1)
    try {
      if (wasLiked) await unlikeMap(slug)
      else await likeMap(slug)
    } catch {
      setLiked((prev) => toggleInSet(prev, slug, wasLiked))
      bumpLike(slug, wasLiked ? 1 : -1)
    }
  }
  const toggleSave = async (slug: string) => {
    const wasSaved = saved.has(slug)
    setSaved((prev) => toggleInSet(prev, slug, !wasSaved))
    try {
      if (wasSaved) await unsaveMap(slug)
      else await saveMap(slug)
    } catch {
      setSaved((prev) => toggleInSet(prev, slug, wasSaved))
    }
  }

  // Suivi persistant : mise à jour optimiste (ensemble + compteurs du profil
  // ouvert), revert si l'appel échoue.
  const toggleFollow = async (uid: string) => {
    const wasFollowing = following.has(uid)
    setFollowing((prev) => {
      const next = new Set(prev)
      if (wasFollowing) next.delete(uid)
      else next.add(uid)
      return next
    })
    setCreatorData((prev) =>
      prev && prev.creator.uid === uid
        ? {
            ...prev,
            following: !wasFollowing,
            creator: {
              ...prev.creator,
              followerCount: Math.max(0, prev.creator.followerCount + (wasFollowing ? -1 : 1)),
            },
          }
        : prev,
    )
    try {
      if (wasFollowing) await unfollowCreator(uid)
      else await followCreator(uid)
    } catch {
      setFollowing((prev) => {
        const next = new Set(prev)
        if (wasFollowing) next.add(uid)
        else next.delete(uid)
        return next
      })
    }
  }

  const openCreator = (uid: string) => {
    setQuery('')
    setView('creator')
    setCreatorData(null)
    setCreatorLoading(true)
    fetchCreator(uid)
      .then((data) => {
        setCreatorData(data)
        setFollowing((prev) => {
          const next = new Set(prev)
          if (data.following) next.add(uid)
          return next
        })
      })
      .catch(() => setCreatorData(null))
      .finally(() => setCreatorLoading(false))
  }

  const go = (next: FeedView) => {
    setQuery('')
    setView(next)
    setMenuOpen(false)
  }

  const navItems: { id: FeedView; label: string; icon: ReactNode }[] = [
    { id: 'feed', label: 'Accueil', icon: <Home size={19} /> },
    { id: 'explore', label: 'Explorer', icon: <Globe size={19} /> },
    { id: 'following', label: 'Créateurs suivis', icon: <Users size={19} /> },
    { id: 'saved', label: 'Enregistrées', icon: <Bookmark size={19} /> },
  ]

  const followingCards = (explore ?? []).filter((card) => following.has(card.author.uid))
  const visibleSuggestions = suggestions.filter((creator) => !following.has(creator.uid))

  const renderCards = (cards: SocialCard[], emptyLabel: string) =>
    cards.length ? (
      <div className="feed-list">
        {cards.map((card) => (
          <PostCard
            key={card.slug}
            card={card}
            liked={liked.has(card.slug)}
            saved={saved.has(card.slug)}
            likeCount={card.likeCount}
            onToggleLike={() => toggleLike(card.slug)}
            onToggleSave={() => toggleSave(card.slug)}
            onOpenCreator={() => openCreator(card.author.uid)}
          />
        ))}
      </div>
    ) : (
      <div className="feed-empty">
        <Mountain size={30} />
        <p>{emptyLabel}</p>
      </div>
    )

  const renderLoading = () => (
    <div className="feed-empty">
      <Mountain size={30} />
      <p>Chargement…</p>
    </div>
  )

  const renderSearch = () => {
    const results = searchResults
    const ready = results !== null && results.q === query.trim()
    const hasResults =
      ready && (results.creators.length > 0 || results.maps.length > 0)
    return (
      <>
        <h2 className="feed-section-title">
          <Search size={18} /> Résultats pour « {query.trim()} »
        </h2>
        {!ready ? (
          renderLoading()
        ) : hasResults ? (
          <>
            {results.creators.length ? (
              <div className="feed-search-creators">
                {results.creators.map((creator) => (
                  <button
                    key={creator.uid}
                    className="feed-suggest-user"
                    type="button"
                    onClick={() => openCreator(creator.uid)}
                  >
                    <Avatar
                      name={creator.name}
                      photoURL={creator.photoURL}
                      color={colorFromId(creator.uid)}
                      size={40}
                    />
                    <span>
                      <strong>{creator.name}</strong>
                      <em>
                        {creator.handle
                          ? `@${creator.handle}`
                          : `${creator.mapCount} carte${creator.mapCount > 1 ? 's' : ''}`}
                      </em>
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
            {renderCards(results.maps, 'Aucune carte pour cette recherche.')}
          </>
        ) : (
          <div className="feed-empty">
            <Mountain size={30} />
            <p>Aucun résultat.</p>
          </div>
        )}
      </>
    )
  }

  const renderCenter = () => {
    if (query.trim().length >= 2) return renderSearch()
    if (view === 'creator') {
      if (creatorLoading) return renderLoading()
      if (!creatorData) {
        return renderCards([], 'Profil introuvable.')
      }
      return (
        <CreatorProfile
          creator={creatorData.creator}
          following={following.has(creatorData.creator.uid)}
          onToggleFollow={() => toggleFollow(creatorData.creator.uid)}
          cards={creatorData.cards}
        />
      )
    }
    if (view === 'explore') {
      return (
        <>
          <h2 className="feed-section-title">
            <Globe size={18} /> Explorer
          </h2>
          {explore === null
            ? renderLoading()
            : renderCards(explore, 'Aucune carte publique pour l’instant.')}
        </>
      )
    }
    if (view === 'following') {
      return (
        <>
          <h2 className="feed-section-title">
            <Users size={18} /> Créateurs suivis
          </h2>
          {explore === null
            ? renderLoading()
            : renderCards(
                followingCards,
                'Tu ne suis encore personne. Explore pour trouver des créateurs.',
              )}
        </>
      )
    }
    if (view === 'saved') {
      const cards = (savedCards ?? []).filter((card) => saved.has(card.slug))
      return (
        <>
          <h2 className="feed-section-title">
            <Bookmark size={18} /> Enregistrées
          </h2>
          {savedCards === null
            ? renderLoading()
            : renderCards(cards, 'Aucune carte enregistrée pour le moment.')}
        </>
      )
    }
    if (feed === null) return renderLoading()
    return renderCards(feed, 'Ton feed est vide. Explore pour suivre des créateurs.')
  }

  return (
    <div className="feed-shell">
      <header className="feed-header">
        <div className="feed-brand">
          <span className="portal-logo">
            <Compass size={22} />
          </span>
          <strong>Relieo</strong>
        </div>
        <label className="feed-search">
          <Search size={17} />
          <input
            type="search"
            placeholder="Rechercher une carte, un créateur…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
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
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    onOpenProfile()
                  }}
                >
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
                    <button role="menuitem" type="button" onClick={onOpenDashboard}>
                      <LayoutDashboard size={16} /> Dashboard créateur
                    </button>
                    <button role="menuitem" type="button" onClick={onOpenDashboard}>
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
            <h3>
              <UserPlus size={16} /> Créateurs à suivre
            </h3>
            {visibleSuggestions.length ? (
              <ul className="feed-suggest">
                {visibleSuggestions.map((creator) => (
                  <li key={creator.uid}>
                    <button
                      className="feed-suggest-user"
                      type="button"
                      onClick={() => openCreator(creator.uid)}
                    >
                      <Avatar
                        name={creator.name}
                        photoURL={creator.photoURL}
                        color={colorFromId(creator.uid)}
                        size={38}
                      />
                      <span>
                        <strong>{creator.name}</strong>
                        <em>{formatCount(creator.followerCount)} abonnés</em>
                      </span>
                    </button>
                    <button
                      className="feed-follow"
                      type="button"
                      onClick={() => toggleFollow(creator.uid)}
                    >
                      Suivre
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="feed-aside-empty">
                Pas encore de créateur à suggérer.
              </p>
            )}
          </section>
        </aside>
      </div>

      <nav className="feed-tabbar">
        <button
          className={view === 'feed' ? 'active' : ''}
          type="button"
          onClick={() => go('feed')}
        >
          <Home size={20} />
          <span>Accueil</span>
        </button>
        <button
          className={view === 'explore' ? 'active' : ''}
          type="button"
          onClick={() => go('explore')}
        >
          <Globe size={20} />
          <span>Explorer</span>
        </button>
        <button
          className={view === 'saved' ? 'active' : ''}
          type="button"
          onClick={() => go('saved')}
        >
          <Bookmark size={20} />
          <span>Enregistrées</span>
        </button>
        <button type="button" onClick={onOpenProfile}>
          <UserRound size={20} />
          <span>Profil</span>
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
            <span className="feed-upsell-badge">
              <Sparkles size={22} />
            </span>
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
  following,
  onToggleFollow,
  cards,
}: {
  creator: SocialCreator
  following: boolean
  onToggleFollow: () => void
  cards: SocialCard[]
}) {
  return (
    <div className="feed-profile">
      <div
        className="feed-profile-banner"
        style={{ backgroundImage: gradientFromSlug(creator.uid) }}
      />
      <div className="feed-profile-head">
        <Avatar
          name={creator.name}
          photoURL={creator.photoURL}
          color={colorFromId(creator.uid)}
          size={92}
        />
        <div className="feed-profile-id">
          <h2>
            {creator.name}
            <span className="feed-badge">Créateur</span>
          </h2>
          {creator.handle ? <p className="feed-profile-handle">@{creator.handle}</p> : null}
          {creator.bio ? <p className="feed-profile-bio">{creator.bio}</p> : null}
          {creator.location ? (
            <p className="feed-profile-loc">
              <MapPin size={14} /> {creator.location}
            </p>
          ) : null}
        </div>
        <button
          className={`feed-follow big${following ? ' following' : ''}`}
          type="button"
          onClick={onToggleFollow}
        >
          {following ? <Check size={15} /> : <UserPlus size={15} />}
          {following ? 'Suivi' : 'Suivre'}
        </button>
      </div>
      <ul className="feed-profile-counters">
        <li>
          <strong>{formatCount(creator.followerCount)}</strong> abonnés
        </li>
        <li>
          <strong>{formatCount(creator.followingCount)}</strong> abonnements
        </li>
        <li>
          <strong>{creator.mapCount}</strong> cartes
        </li>
      </ul>
      {cards.length ? (
        <div className="feed-grid">
          {cards.map((card) => (
            <button
              key={card.slug}
              className="feed-grid-card"
              type="button"
              onClick={() => openMap(card.slug)}
            >
              <span
                className="feed-grid-cover"
                style={{ backgroundImage: gradientFromSlug(card.slug) }}
              />
              <span className="feed-grid-title">{card.title}</span>
              <span className="feed-grid-meta">
                <Images size={12} /> {card.mediaCount}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="feed-empty">
          <Mountain size={30} />
          <p>Aucune carte publique.</p>
        </div>
      )}
    </div>
  )
}
