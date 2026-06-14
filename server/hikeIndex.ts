import { r2GetText, r2PutText } from './r2.js'

// Registre central des randonnées : permet de lister plusieurs randos (et
// plusieurs randos par propriétaire) sans dépendre du pointeur « active.json »
// mono-rando. Chaque entrée est indépendante ; on n'écrase jamais les autres.
export const hikeIndexPath = 'rando3d/index.json'

export type HikeIndexEntry = {
  code: string
  folder: string
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
