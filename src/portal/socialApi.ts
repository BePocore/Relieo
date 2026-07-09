import { getIdToken } from './firebase'

// Client du réseau social : appels authentifiés vers `/api/social` (même origine,
// jeton Firebase). Types miroir de `server/social.ts`.

export type SocialAuthor = {
  uid: string
  name: string
  handle: string | null
  photoURL?: string
}

export type SocialCard = {
  slug: string
  title: string
  distanceKm: number
  elevationGain: number
  mediaCount: number
  likeCount: number
  saveCount: number
  protected: boolean
  coverUrl: string
  updatedAt: string
  author: SocialAuthor
}

export type SocialCreator = SocialAuthor & {
  bio?: string
  location?: string
  followerCount: number
  followingCount: number
  mapCount: number
}

export type SocialContext = {
  handle: string | null
  suggestedHandle: string
  following: string[]
  liked: string[]
  saved: string[]
  followerCount: number
  followingCount: number
}

const authHeaders = async (): Promise<Record<string, string>> => {
  const token = await getIdToken()
  if (!token) throw new Error('Connexion requise.')
  return { Authorization: `Bearer ${token}` }
}

const get = async <T>(action: string, params: Record<string, string> = {}): Promise<T> => {
  const query = new URLSearchParams({ action, ...params }).toString()
  const response = await fetch(`/api/social?${query}`, {
    cache: 'no-store',
    headers: await authHeaders(),
  })
  if (!response.ok) throw new Error(`social:${action}:${response.status}`)
  return (await response.json()) as T
}

const post = async <T>(body: Record<string, unknown>): Promise<T> => {
  const response = await fetch('/api/social', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`social:${String(body.action)}:${response.status}`)
  return (await response.json()) as T
}

export const fetchContext = () => get<SocialContext>('context')
export const fetchFeed = () => get<{ cards: SocialCard[] }>('feed').then((r) => r.cards)
export const fetchExplore = () => get<{ cards: SocialCard[] }>('explore').then((r) => r.cards)
export const fetchSaved = () => get<{ cards: SocialCard[] }>('saved').then((r) => r.cards)
export const fetchSuggestions = () =>
  get<{ creators: SocialCreator[] }>('suggestions').then((r) => r.creators)
export const fetchFollowingCreators = () =>
  get<{ creators: SocialCreator[] }>('following').then((r) => r.creators)
export const fetchSearch = (q: string) =>
  get<{ maps: SocialCard[]; creators: SocialCreator[] }>('search', { q })
export const fetchCreator = (uid: string) =>
  get<{ creator: SocialCreator; cards: SocialCard[]; following: boolean }>('creator', { uid })

export const followCreator = (uid: string) =>
  post<{ following: boolean }>({ action: 'follow', uid })
export const unfollowCreator = (uid: string) =>
  post<{ following: boolean }>({ action: 'unfollow', uid })

export const likeMap = (slug: string) => post<{ on: boolean }>({ action: 'like', slug })
export const unlikeMap = (slug: string) => post<{ on: boolean }>({ action: 'unlike', slug })
export const saveMap = (slug: string) => post<{ on: boolean }>({ action: 'save', slug })
export const unsaveMap = (slug: string) => post<{ on: boolean }>({ action: 'unsave', slug })

export const checkHandle = (handle: string) =>
  post<{ available: boolean; handle: string | null; reason?: string }>({
    action: 'check-handle',
    handle,
  })
export const saveHandle = (handle: string) =>
  post<{ ok: boolean; handle?: string; reason?: string }>({ action: 'set-handle', handle })
