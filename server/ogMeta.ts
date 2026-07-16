import { r2DeleteObject, r2PutText } from './r2.js'
import { publicCoverUrl } from './publicCovers.js'

// Métadonnées PUBLIQUES d'aperçu (Open Graph) d'une carte PUBLIÉE, écrites en
// `relieo/public/og/<slug>.json` (servi sans ticket par le videur). Le
// middleware Edge (`middleware.ts`) les lit pour injecter les balises OG dans le
// HTML vu par les robots d'aperçu (Discord, WhatsApp, iMessage, Facebook…), sans
// aucun secret côté Edge. Best-effort : ne jette jamais.

const OG_PREFIX = 'relieo/public/og/'
const ogKey = (slug: string): string => `${OG_PREFIX}${slug}.json`

// Les points serveur ont un index signature (`[key: string]: unknown`) : on
// reprend la même forme pour accepter directement `StoredPoint[]`, et on coerce
// `placeName` à la lecture.
type OgPoint = { [key: string]: unknown }

// Lieu dominant de la carte = le `placeName` (géocodé) le plus fréquent parmi
// les points. Sert de contexte dans la description (« 42 photos · Lofoten »).
const dominantPlace = (points?: OgPoint[]): string | undefined => {
  if (!points?.length) return undefined
  const counts = new Map<string, number>()
  for (const point of points) {
    const name =
      typeof point.placeName === 'string' ? point.placeName.trim() : undefined
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name
      bestCount = count
    }
  }
  return best
}

const buildDescription = (
  place: string | undefined,
  mediaCount: number,
): string => {
  const bits: string[] = []
  if (place) bits.push(place)
  if (mediaCount > 0) {
    bits.push(`${mediaCount} photo${mediaCount > 1 ? 's' : ''}`)
  }
  return bits.join(' · ') || 'Carnet cartographique 3D'
}

type OgInput = {
  slug?: string
  status: string
  title?: string
  points?: OgPoint[]
  mediaCount?: number
}

// (Ré)écrit ou retire le JSON OG selon le statut de la carte.
export const syncOgMeta = async (input: OgInput): Promise<void> => {
  const slug = input.slug?.trim()
  if (!slug) return
  const key = ogKey(slug)
  try {
    if (input.status !== 'published') {
      await r2DeleteObject(key).catch(() => undefined)
      return
    }
    const meta = {
      title: input.title?.trim() || 'Relieo',
      description: buildDescription(
        dominantPlace(input.points),
        input.mediaCount ?? 0,
      ),
      image: publicCoverUrl(slug),
    }
    // skipQuota : minuscule, et évite un scan complet du bucket.
    await r2PutText(key, JSON.stringify(meta), undefined, { skipQuota: true })
  } catch {
    // best-effort
  }
}

export const deleteOgMeta = async (slug?: string): Promise<void> => {
  const trimmed = slug?.trim()
  if (!trimmed) return
  await r2DeleteObject(ogKey(trimmed)).catch(() => undefined)
}
