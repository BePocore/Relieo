export type PortalUser = {
  id: string
  name: string
  email: string
  passwordHash: string
  location: string
  bio: string
  createdAt: string
}

export type PortalHike = {
  id: string
  // Propriétaire de la randonnée = l'utilisateur qui a l'accès Studio.
  // C'est ce lien (ownerId → PortalUser.id) qui « affecte » une rando à une personne.
  ownerId: string
  title: string
  // `code` = identifiant partagé de la randonnée. C'est aussi la clé de son
  // dossier R2 côté Vercel (rando3d/randonnees/<code>). Sert à ouvrir LA bonne
  // randonnée depuis le dashboard.
  code: string
  status: 'published' | 'draft'
  distanceKm: number
  elevationGain: number
  mediaCount: number
  pointCount: number
  updatedAt: string
  coverUrl?: string
}

const userKey = 'rando3d-portal-user'
const sessionKey = 'rando3d-portal-session'
const hikesKey = 'rando3d-portal-hikes'

const halsaCover =
  'https://pub-6e336e685535453c9bbafab6421d8fc6.r2.dev/rando3d/randonnees/Halsa/previews/34cbfc6ea1455f26dd5ebb4f.jpg'

// Modèle des randos d'exemple, sans propriétaire : il est attribué au moment du
// « seed » (à l'inscription) via seedHikes(ownerId).
const defaultHikes: Omit<PortalHike, 'ownerId'>[] = [
  {
    id: 'halsa',
    title: 'Halsa · Norvège',
    code: 'Halsa',
    status: 'published',
    distanceKm: 20.9,
    elevationGain: 1045,
    mediaCount: 66,
    pointCount: 70,
    updatedAt: '2026-06-14T18:00:15.871Z',
    coverUrl: halsaCover,
  },
]

const seedHikes = (ownerId: string): PortalHike[] =>
  defaultHikes.map((hike) => ({ ...hike, ownerId }))

export const hashPassword = async (password: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(password),
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export const readUser = (): PortalUser | null => {
  try {
    const stored = window.localStorage.getItem(userKey)
    return stored ? (JSON.parse(stored) as PortalUser) : null
  } catch {
    return null
  }
}

export const saveUser = (user: PortalUser): void => {
  window.localStorage.setItem(userKey, JSON.stringify(user))
}

export const hasSession = (): boolean => {
  const user = readUser()
  return Boolean(user && window.localStorage.getItem(sessionKey) === user.id)
}

export const startSession = (user: PortalUser): void => {
  window.localStorage.setItem(sessionKey, user.id)
}

export const endSession = (): void => {
  window.localStorage.removeItem(sessionKey)
}

// Toutes les randos stockées (tous propriétaires confondus).
// Migration douce : les anciennes randos sans ownerId sont rattachées à
// l'utilisateur local courant.
export const readHikes = (): PortalHike[] => {
  try {
    const stored = window.localStorage.getItem(hikesKey)
    if (!stored) return []
    const hikes = JSON.parse(stored) as PortalHike[]
    const fallbackOwner = readUser()?.id ?? ''
    let changed = false
    const normalized = hikes.map((hike) => {
      if (!hike.ownerId) {
        changed = true
        return { ...hike, ownerId: fallbackOwner }
      }
      return hike
    })
    if (changed) {
      window.localStorage.setItem(hikesKey, JSON.stringify(normalized))
    }
    return normalized
  } catch {
    return []
  }
}

// Les randonnées d'un propriétaire donné (ce qu'affiche son dashboard).
export const readHikesForOwner = (ownerId: string): PortalHike[] =>
  readHikes().filter((hike) => hike.ownerId === ownerId)

export const saveHikes = (hikes: PortalHike[]): void => {
  window.localStorage.setItem(hikesKey, JSON.stringify(hikes))
}

// Remplace les randos d'un propriétaire sans toucher à celles des autres.
export const saveHikesForOwner = (
  ownerId: string,
  hikes: PortalHike[],
): void => {
  const others = readHikes().filter((hike) => hike.ownerId !== ownerId)
  saveHikes([...others, ...hikes])
}

// (Ré)initialise la bibliothèque du propriétaire avec les randos d'exemple.
export const resetHikes = (ownerId: string): void => {
  saveHikesForOwner(ownerId, seedHikes(ownerId))
}

// Extras de profil pour les comptes Firebase (nom/localisation/bio éditables),
// stockés par uid. L'identité (email, photo) vient de Firebase.
export type ProfileExtras = {
  name?: string
  location?: string
  bio?: string
}

const profileExtrasKey = (uid: string): string =>
  `rando3d-portal-profile-${uid}`

export const readProfileExtras = (uid: string): ProfileExtras => {
  try {
    const stored = window.localStorage.getItem(profileExtrasKey(uid))
    return stored ? (JSON.parse(stored) as ProfileExtras) : {}
  } catch {
    return {}
  }
}

export const saveProfileExtras = (uid: string, extras: ProfileExtras): void => {
  window.localStorage.setItem(profileExtrasKey(uid), JSON.stringify(extras))
}
