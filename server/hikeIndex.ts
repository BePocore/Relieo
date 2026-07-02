import { r2GetText, r2PutText } from './r2.js'
import { trailFolder } from './trailStorage.js'

// Registre central des randonnées : permet de lister plusieurs randos (et
// plusieurs randos par propriétaire) sans dépendre du pointeur « active.json »
// mono-rando. Chaque entrée est indépendante ; on n'écrase jamais les autres.
export const hikeIndexPath = 'relieo/index.json'

export type HikeIndexEntry = {
  code: string
  folder: string
  // Identifiant OPAQUE d'URL (`?m=<slug>`), distinct du `folder` de stockage et
  // du code d'accès. Il ne révèle rien et n'est pas secret. Optionnel tant que la
  // migration `migrate-slugs` n'est pas passée sur les entrées historiques.
  slug?: string
  // Empreinte SHA-256 (salée par le slug) du CODE D'ACCÈS secret. Jamais le
  // plaintext, jamais renvoyé au public. Présente ⇒ carte protégée (Type 1).
  accessCodeHash?: string
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

// Patch partiel : seuls les champs définis écrasent l'entrée existante (fusion).
// `folder` est obligatoire car c'est la clé d'identité de la rando.
export type HikeIndexPatch = Partial<HikeIndexEntry> & { folder: string }

export const readHikeIndex = async (): Promise<HikeIndexEntry[]> => {
  const body = await r2GetText(hikeIndexPath)
  if (!body) return []
  try {
    const value = JSON.parse(body) as { hikes?: unknown }
    return Array.isArray(value.hikes) ? (value.hikes as HikeIndexEntry[]) : []
  } catch {
    return []
  }
}

// Propriétaire d'une rando à partir de son dossier (clé d'identité). Sert à
// résoudre la clé de stockage `relieo/users/<ownerId>/...` lors d'une lecture
// publique par `?code=`, où l'uid n'est pas connu côté requête.
export const ownerForFolder = async (
  folder: string,
): Promise<string | null> => {
  if (!folder) return null
  const hikes = await readHikeIndex()
  return hikes.find((hike) => hike.folder === folder)?.ownerId || null
}

// Résout une entrée à partir de l'identifiant d'URL. On tente d'abord le `slug`
// opaque (nouveau schéma), puis on retombe sur le `folder` (rétrocompat des
// vieux liens `?code=<folder>`, ex. « Halsa »). Renvoie null si rien ne matche.
export const resolveHikeEntry = async (
  idParam: string,
): Promise<HikeIndexEntry | null> => {
  const id = idParam?.trim()
  if (!id) return null
  const hikes = await readHikeIndex()
  const bySlug = hikes.find((hike) => hike.slug === id)
  if (bySlug) return bySlug
  let folder: string
  try {
    folder = trailFolder(id)
  } catch {
    return null
  }
  return hikes.find((hike) => hike.folder === folder) ?? null
}

const stripUndefined = <T extends object>(value: T): Partial<T> => {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>
}

// Insère ou met à jour l'entrée d'une rando (clé = folder), en conservant les
// champs déjà connus que le patch ne fournit pas. Les autres randos sont
// laissées telles quelles.
export const upsertHikeIndex = async (
  patch: HikeIndexPatch,
): Promise<HikeIndexEntry[]> => {
  const hikes = await readHikeIndex()
  const existing = hikes.find((hike) => hike.folder === patch.folder)
  const others = hikes.filter((hike) => hike.folder !== patch.folder)

  const merged: HikeIndexEntry = {
    code: patch.folder,
    ownerId: '',
    title: patch.folder,
    status: 'published',
    distanceKm: 0,
    elevationGain: 0,
    pointCount: 0,
    mediaCount: 0,
    updatedAt: new Date().toISOString(),
    ...existing,
    ...stripUndefined(patch),
    folder: patch.folder,
  }

  const next = [merged, ...others]
  await r2PutText(hikeIndexPath, JSON.stringify({ hikes: next }))
  return next
}

// Retire l'entrée d'une rando du registre (clé = folder). Les autres entrées
// sont conservées. Utilisé par la suppression admin d'une carte.
export const removeHikeIndex = async (
  folder: string,
): Promise<HikeIndexEntry[]> => {
  const hikes = await readHikeIndex()
  const next = hikes.filter((hike) => hike.folder !== folder)
  if (next.length !== hikes.length) {
    await r2PutText(hikeIndexPath, JSON.stringify({ hikes: next }))
  }
  return next
}

// Retire TOUTES les cartes d'un propriétaire du registre (suppression de compte).
// Renvoie les dossiers retirés pour permettre le nettoyage R2 / pointeur public.
export const removeOwnerFromIndex = async (
  ownerId: string,
): Promise<string[]> => {
  const hikes = await readHikeIndex()
  const removed = hikes.filter((hike) => hike.ownerId === ownerId)
  if (removed.length === 0) return []
  const next = hikes.filter((hike) => hike.ownerId !== ownerId)
  await r2PutText(hikeIndexPath, JSON.stringify({ hikes: next }))
  return removed.map((hike) => hike.folder)
}
