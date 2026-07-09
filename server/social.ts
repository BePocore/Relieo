import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import { adminApp } from './firebaseAdmin.js'
import { readHikeIndex, type HikeIndexEntry } from './hikeIndex.js'

// ─────────────────────────────────────────────────────────────────────────────
// Backend du réseau social (feed / explorer / profils créateurs / suivis /
// pseudos). Tout est écrit UNIQUEMENT via l'Admin SDK (contourne les règles
// Firestore) : le client passe par `/api/social`, il n'écrit jamais ces
// collections en direct — donc pas de triche sur les compteurs, et aucune
// nouvelle règle Firestore à déployer (ces collections sont refusées par défaut).
//
// Collections Firestore :
//   social_handles/<handle>            = { uid, createdAt }        (pseudo unique)
//   social_follows/<follower>__<creator> = { follower, creator, createdAt }
//   profiles/<uid>.followerCount / .followingCount / .handle       (compteurs O(1))
// ─────────────────────────────────────────────────────────────────────────────

const db = () => getFirestore(adminApp())
const now = () => new Date().toISOString()

// ── Types renvoyés au client ────────────────────────────────────────────────

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

// Compteurs par carte (likes / enregistrements), maintenus en O(1) dans
// Firestore `social_maps/<slug>` via transaction.
type MapCounts = { likeCount: number; saveCount: number }

// ── Profils (lecture) ───────────────────────────────────────────────────────

type SocialProfile = {
  uid: string
  name: string
  handle: string | null
  photoURL?: string
  bio?: string
  location?: string
  followerCount: number
  followingCount: number
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const toProfile = (uid: string, data: DocumentData | undefined): SocialProfile => ({
  uid,
  name: str(data?.name) ?? 'Créateur',
  handle: str(data?.handle) ?? null,
  photoURL: str(data?.photoURL),
  bio: str(data?.bio),
  location: str(data?.location),
  followerCount: count(data?.followerCount),
  followingCount: count(data?.followingCount),
})

// Tous les profils indexés par uid (une seule lecture de collection). Sert à
// habiller les cartes du feed avec l'identité de leur auteur.
const readProfiles = async (): Promise<Map<string, SocialProfile>> => {
  const snapshot = await db().collection('profiles').get()
  const map = new Map<string, SocialProfile>()
  for (const doc of snapshot.docs) map.set(doc.id, toProfile(doc.id, doc.data()))
  return map
}

const readProfile = async (uid: string): Promise<SocialProfile> => {
  const snapshot = await db().collection('profiles').doc(uid).get()
  return toProfile(uid, snapshot.data())
}

const authorOf = (profile: SocialProfile | undefined, uid: string): SocialAuthor =>
  profile
    ? { uid, name: profile.name, handle: profile.handle, photoURL: profile.photoURL }
    : { uid, name: 'Créateur', handle: null }

// ── Cartes publiques ────────────────────────────────────────────────────────

// Une carte apparaît dans le réseau social si elle est PUBLIÉE et PUBLIQUE :
// une carte protégée par un code d'accès (`accessCodeHash`) ne fuite jamais ici.
const isPublicMap = (hike: HikeIndexEntry): boolean =>
  hike.status === 'published' && !hike.accessCodeHash

const mapIdentity = (hike: HikeIndexEntry): string => hike.slug ?? hike.folder

const toCard = (
  hike: HikeIndexEntry,
  profiles: Map<string, SocialProfile>,
  counts: Map<string, MapCounts>,
): SocialCard => {
  const slug = mapIdentity(hike)
  const mapCounts = counts.get(slug)
  return {
    slug,
    title: hike.title,
    distanceKm: hike.distanceKm,
    elevationGain: hike.elevationGain,
    mediaCount: hike.mediaCount,
    likeCount: mapCounts?.likeCount ?? 0,
    saveCount: mapCounts?.saveCount ?? 0,
    updatedAt: hike.updatedAt,
    author: authorOf(profiles.get(hike.ownerId), hike.ownerId),
  }
}

// Compteurs de toutes les cartes en une seule lecture de collection.
const readMapCounts = async (): Promise<Map<string, MapCounts>> => {
  const snapshot = await db().collection('social_maps').get()
  const map = new Map<string, MapCounts>()
  for (const doc of snapshot.docs) {
    const data = doc.data()
    map.set(doc.id, { likeCount: count(data.likeCount), saveCount: count(data.saveCount) })
  }
  return map
}

const byRecent = (a: HikeIndexEntry, b: HikeIndexEntry): number =>
  b.updatedAt.localeCompare(a.updatedAt)

// Proxy de popularité tant que les likes ne sont pas persistés (tranche 2) :
// les cartes les plus fournies en médias d'abord, puis les plus récentes.
const byPopular = (a: HikeIndexEntry, b: HikeIndexEntry): number =>
  b.mediaCount - a.mediaCount || byRecent(a, b)

// ── Suivis ──────────────────────────────────────────────────────────────────

const followId = (follower: string, creator: string): string =>
  `${follower}__${creator}`

export const getFollowing = async (uid: string): Promise<string[]> => {
  const snapshot = await db()
    .collection('social_follows')
    .where('follower', '==', uid)
    .get()
  return snapshot.docs.map((doc) => String(doc.data().creator)).filter(Boolean)
}

export const setFollow = async (
  follower: string,
  creator: string,
  follow: boolean,
): Promise<{ following: boolean }> => {
  if (!creator || follower === creator) return { following: false }
  const database = db()
  const followRef = database.collection('social_follows').doc(followId(follower, creator))
  const meRef = database.collection('profiles').doc(follower)
  const creatorRef = database.collection('profiles').doc(creator)
  await database.runTransaction(async (tx) => {
    const existing = await tx.get(followRef)
    if (follow && existing.exists) return
    if (!follow && !existing.exists) return
    if (follow) {
      tx.set(followRef, { follower, creator, createdAt: now() })
      tx.set(meRef, { followingCount: FieldValue.increment(1) }, { merge: true })
      tx.set(creatorRef, { followerCount: FieldValue.increment(1) }, { merge: true })
    } else {
      tx.delete(followRef)
      tx.set(meRef, { followingCount: FieldValue.increment(-1) }, { merge: true })
      tx.set(creatorRef, { followerCount: FieldValue.increment(-1) }, { merge: true })
    }
  })
  return { following: follow }
}

// ── Likes / enregistrements ─────────────────────────────────────────────────

const relationId = (uid: string, slug: string): string => `${uid}__${slug}`

const listSlugsFor = async (
  collection: 'social_likes' | 'social_saves',
  uid: string,
): Promise<string[]> => {
  const snapshot = await db().collection(collection).where('user', '==', uid).get()
  return snapshot.docs.map((doc) => String(doc.data().slug)).filter(Boolean)
}

export const getLiked = (uid: string): Promise<string[]> =>
  listSlugsFor('social_likes', uid)
export const getSaved = (uid: string): Promise<string[]> =>
  listSlugsFor('social_saves', uid)

// Bascule un like ou un enregistrement (idempotent) et maintient le compteur de
// la carte (`social_maps/<slug>`) dans la même transaction.
const setRelation = async (
  collection: 'social_likes' | 'social_saves',
  counterField: 'likeCount' | 'saveCount',
  uid: string,
  slug: string,
  on: boolean,
): Promise<{ on: boolean }> => {
  if (!slug) return { on: false }
  const database = db()
  const relRef = database.collection(collection).doc(relationId(uid, slug))
  const mapRef = database.collection('social_maps').doc(slug)
  await database.runTransaction(async (tx) => {
    const existing = await tx.get(relRef)
    if (on && existing.exists) return
    if (!on && !existing.exists) return
    if (on) {
      tx.set(relRef, { user: uid, slug, createdAt: now() })
      tx.set(mapRef, { [counterField]: FieldValue.increment(1) }, { merge: true })
    } else {
      tx.delete(relRef)
      tx.set(mapRef, { [counterField]: FieldValue.increment(-1) }, { merge: true })
    }
  })
  return { on }
}

export const setLike = (uid: string, slug: string, on: boolean) =>
  setRelation('social_likes', 'likeCount', uid, slug, on)
export const setSave = (uid: string, slug: string, on: boolean) =>
  setRelation('social_saves', 'saveCount', uid, slug, on)

// ── Pseudos uniques ─────────────────────────────────────────────────────────

const HANDLE_RE = /^[a-z0-9_]{3,20}$/

// Normalise une saisie de pseudo : retire l'éventuel « @ », minuscule, ne garde
// que [a-z0-9_]. Renvoie null si le résultat ne respecte pas la forme attendue.
export const normalizeHandle = (raw: string): string | null => {
  const handle = String(raw ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
  return HANDLE_RE.test(handle) ? handle : null
}

// Suggestion de pseudo dérivée du nom (ou de l'email), garantie bien FORMÉE mais
// pas forcément libre (le client vérifie la dispo). Sert de valeur pré-remplie.
export const suggestHandle = (name: string, email: string): string => {
  const base = (name || email.split('@')[0] || 'relieo')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20)
  if (base.length >= 3) return base
  return (base + 'relieo').slice(0, 20)
}

export const isHandleAvailable = async (
  uid: string,
  raw: string,
): Promise<{ available: boolean; handle: string | null; reason?: string }> => {
  const handle = normalizeHandle(raw)
  if (!handle) return { available: false, handle: null, reason: 'invalid' }
  const snapshot = await db().collection('social_handles').doc(handle).get()
  const takenByOther = snapshot.exists && snapshot.data()?.uid !== uid
  return { available: !takenByOther, handle, reason: takenByOther ? 'taken' : undefined }
}

export const setHandle = async (
  uid: string,
  raw: string,
): Promise<{ ok: boolean; handle?: string; reason?: string }> => {
  const handle = normalizeHandle(raw)
  if (!handle) return { ok: false, reason: 'invalid' }
  const database = db()
  const handleRef = database.collection('social_handles').doc(handle)
  const profileRef = database.collection('profiles').doc(uid)
  return database.runTransaction(async (tx) => {
    // Toutes les lectures AVANT les écritures (contrainte des transactions).
    const handleSnap = await tx.get(handleRef)
    if (handleSnap.exists && handleSnap.data()?.uid !== uid) {
      return { ok: false, reason: 'taken' }
    }
    const profileSnap = await tx.get(profileRef)
    const previous = str(profileSnap.data()?.handle)
    if (previous && previous !== handle) {
      tx.delete(database.collection('social_handles').doc(previous))
    }
    tx.set(handleRef, { uid, createdAt: now() })
    tx.set(profileRef, { handle, updatedAt: now() }, { merge: true })
    return { ok: true, handle }
  })
}

// ── Vues assemblées ─────────────────────────────────────────────────────────

// Contexte social du visiteur : son pseudo (+ suggestion si absent) et la liste
// des créateurs qu'il suit (pilote le feed « Accueil »).
export const getContext = async (
  uid: string,
  email: string,
): Promise<SocialContext> => {
  const [me, following, liked, saved] = await Promise.all([
    readProfile(uid),
    getFollowing(uid),
    getLiked(uid),
    getSaved(uid),
  ])
  return {
    handle: me.handle,
    suggestedHandle: me.handle ?? suggestHandle(me.name, email),
    following,
    liked,
    saved,
    followerCount: me.followerCount,
    followingCount: me.followingCount,
  }
}

// Feed « Accueil » : cartes des créateurs suivis (récent d'abord). Repli sur les
// cartes populaires si le visiteur ne suit encore personne (ou aucun suivi n'a
// publié). L'auteur (soi) n'apparaît pas dans son propre feed.
export const getFeed = async (uid: string): Promise<SocialCard[]> => {
  const [hikes, following, profiles, counts] = await Promise.all([
    readHikeIndex(),
    getFollowing(uid),
    readProfiles(),
    readMapCounts(),
  ])
  const followSet = new Set(following)
  const publicMaps = hikes.filter(isPublicMap).filter((h) => h.ownerId !== uid)
  const followed = publicMaps.filter((h) => followSet.has(h.ownerId)).sort(byRecent)
  const source = followed.length > 0 ? followed : [...publicMaps].sort(byPopular)
  return source.map((hike) => toCard(hike, profiles, counts))
}

// Explorer : toutes les cartes publiques, récent d'abord (découverte).
export const getExplore = async (): Promise<SocialCard[]> => {
  const [hikes, profiles, counts] = await Promise.all([
    readHikeIndex(),
    readProfiles(),
    readMapCounts(),
  ])
  return hikes
    .filter(isPublicMap)
    .sort(byRecent)
    .map((hike) => toCard(hike, profiles, counts))
}

// Cartes enregistrées par le visiteur (onglet « Enregistrées »), limitées aux
// cartes toujours publiques.
export const getSavedCards = async (uid: string): Promise<SocialCard[]> => {
  const [hikes, saved, profiles, counts] = await Promise.all([
    readHikeIndex(),
    getSaved(uid),
    readProfiles(),
    readMapCounts(),
  ])
  const savedSet = new Set(saved)
  return hikes
    .filter(isPublicMap)
    .filter((hike) => savedSet.has(mapIdentity(hike)))
    .sort(byRecent)
    .map((hike) => toCard(hike, profiles, counts))
}

// Profil public d'un créateur : son identité, ses compteurs, ses cartes
// publiques, et si le visiteur le suit déjà.
export const getCreator = async (
  viewerUid: string,
  creatorUid: string,
): Promise<{ creator: SocialCreator; cards: SocialCard[]; following: boolean } | null> => {
  if (!creatorUid) return null
  const [hikes, profile, following, profiles, counts] = await Promise.all([
    readHikeIndex(),
    readProfile(creatorUid),
    getFollowing(viewerUid),
    readProfiles(),
    readMapCounts(),
  ])
  const cards = hikes
    .filter(isPublicMap)
    .filter((h) => h.ownerId === creatorUid)
    .sort(byRecent)
    .map((hike) => toCard(hike, profiles, counts))
  const creator: SocialCreator = {
    uid: creatorUid,
    name: profile.name,
    handle: profile.handle,
    photoURL: profile.photoURL,
    bio: profile.bio,
    location: profile.location,
    followerCount: profile.followerCount,
    followingCount: profile.followingCount,
    mapCount: cards.length,
  }
  return { creator, cards, following: following.includes(creatorUid) }
}

// Créateurs suggérés (à suivre) : ceux qui ont au moins une carte publique, que
// le visiteur ne suit pas encore, triés par nombre de cartes.
export const getSuggestions = async (uid: string): Promise<SocialCreator[]> => {
  const [hikes, following, profiles] = await Promise.all([
    readHikeIndex(),
    getFollowing(uid),
    readProfiles(),
  ])
  const followSet = new Set(following)
  const mapCountByOwner = new Map<string, number>()
  for (const hike of hikes.filter(isPublicMap)) {
    mapCountByOwner.set(hike.ownerId, (mapCountByOwner.get(hike.ownerId) ?? 0) + 1)
  }
  const suggestions: SocialCreator[] = []
  for (const [ownerId, mapCount] of mapCountByOwner) {
    if (ownerId === uid || followSet.has(ownerId)) continue
    const profile = profiles.get(ownerId)
    if (!profile) continue
    suggestions.push({
      uid: ownerId,
      name: profile.name,
      handle: profile.handle,
      photoURL: profile.photoURL,
      bio: profile.bio,
      location: profile.location,
      followerCount: profile.followerCount,
      followingCount: profile.followingCount,
      mapCount,
    })
  }
  return suggestions.sort((a, b) => b.mapCount - a.mapCount).slice(0, 8)
}
