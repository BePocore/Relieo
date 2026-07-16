import type {
  SlideshowDaySettings,
  SlideshowEndCardSettings,
  SlideshowMediaSettings,
  SlideshowSettings,
} from '../types'

// ---------------------------------------------------------------------------
// Diaporama : constantes et aides partagées entre le lecteur (MediaLightbox),
// la construction des slides (App.tsx) et l'éditeur du Studio
// (SlideshowEditor). Les réglages persistés (TrailProject.slideshow) sont
// tous facultatifs : absent = comportement automatique historique.
// ---------------------------------------------------------------------------

// Durées d'affichage par défaut en lecture auto (les vidéos, elles, jouent
// jusqu'à leur fin avant d'avancer, pour laisser parler les mini-vlogs).
export const SLIDESHOW_PHOTO_MS = 4200
export const SLIDESHOW_BREAK_MS = 2600

// Clé réservée du Record `days` pour la carte « Non datés » (les jours réels
// sont clés par leur date locale 'YYYY-MM-DD', stable quand le plan de
// journées se recalcule).
export const UNDATED_DAY_KEY = 'undated'

// Clé de section pour l'ordre custom (Record `order`) d'une carte d'un seul
// jour ou d'une exposition photos : une seule section, donc une seule clé.
// (Les dates 'YYYY-MM-DD' et 'undated' servent aux sections multi-jours.)
export const ALL_MEDIA_ORDER_KEY = 'all'

// Réordonne une liste de médias selon un ordre custom (liste d'ids de points).
// Les médias listés viennent en tête, dans l'ordre demandé ; les autres (ids
// inconnus ou nouveaux médias) gardent leur ordre naturel, à la suite. Tolère
// les ids périmés (simplement absents de la liste). Ordre absent ou vide =
// liste inchangée.
export const applyMediaOrder = <T extends { id?: string }>(
  media: T[],
  orderIds: string[] | undefined,
): T[] => {
  if (!orderIds || orderIds.length === 0) return media
  const rank = new Map<string, number>()
  orderIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index)
  })
  const listed: T[] = []
  const rest: T[] = []
  for (const item of media) {
    if (item.id && rank.has(item.id)) listed.push(item)
    else rest.push(item)
  }
  listed.sort((a, b) => (rank.get(a.id as string) ?? 0) - (rank.get(b.id as string) ?? 0))
  return [...listed, ...rest]
}

// Ordre par défaut (narratif) des médias : par jour, puis chronologique (heure
// de prise), les médias datés passant avant les non datés, et les non datés (ou
// les ex æquo) gardant leur ordre le long du tracé. Le tri est stable, donc
// deux médias parfaitement à égalité conservent l'ordre d'entrée.
export const orderMediaByDayTimeTrack = <T>(
  media: T[],
  keys: (item: T) => { day: number; takenMs: number | null; track: number },
): T[] => {
  const keyed = new Map<T, { day: number; takenMs: number | null; track: number }>()
  media.forEach((item) => keyed.set(item, keys(item)))
  return [...media].sort((a, b) => {
    const ka = keyed.get(a) as { day: number; takenMs: number | null; track: number }
    const kb = keyed.get(b) as { day: number; takenMs: number | null; track: number }
    if (ka.day !== kb.day) return ka.day - kb.day
    if (ka.takenMs !== null && kb.takenMs !== null && ka.takenMs !== kb.takenMs) {
      return ka.takenMs - kb.takenMs
    }
    if (ka.takenMs !== null && kb.takenMs === null) return -1
    if (ka.takenMs === null && kb.takenMs !== null) return 1
    return ka.track - kb.track
  })
}

export const defaultDayIntro = (dayIndex: number): string =>
  dayIndex === 0 ? 'Le voyage commence' : 'La suite du voyage'
export const UNDATED_DEFAULT_LABEL = 'Non datés'
export const UNDATED_DEFAULT_INTRO = 'Pour finir'
export const END_CARD_DEFAULT_TITLE = 'Fin du voyage'
export const END_CARD_DEFAULT_INTRO = 'Le voyage se termine'

// Durées proposées pour une photo précise (l'option « auto » = durée globale).
export const MEDIA_DURATION_CHOICES_MS = [
  2000, 3000, 4000, 5000, 6000, 8000, 10000, 15000,
]

// Nettoie les réglages avant de les remonter à App : on ne garde que ce qui
// est réellement personnalisé (project.json reste minimal, et « tout remettre
// par défaut » redonne un projet sans champ `slideshow` du tout).
export const cleanSlideshowSettings = (
  settings: SlideshowSettings,
): SlideshowSettings | undefined => {
  const cleaned: SlideshowSettings = {}

  if (
    typeof settings.photoMs === 'number' &&
    Number.isFinite(settings.photoMs) &&
    settings.photoMs > 0 &&
    Math.round(settings.photoMs) !== SLIDESHOW_PHOTO_MS
  ) {
    cleaned.photoMs = Math.round(settings.photoMs)
  }
  if (
    typeof settings.breakMs === 'number' &&
    Number.isFinite(settings.breakMs) &&
    settings.breakMs > 0 &&
    Math.round(settings.breakMs) !== SLIDESHOW_BREAK_MS
  ) {
    cleaned.breakMs = Math.round(settings.breakMs)
  }

  const days: Record<string, SlideshowDaySettings> = {}
  for (const [key, value] of Object.entries(settings.days ?? {})) {
    const entry: SlideshowDaySettings = {}
    if (value.title?.trim()) entry.title = value.title
    if (value.intro?.trim()) entry.intro = value.intro
    if (Object.keys(entry).length > 0) days[key] = entry
  }
  if (Object.keys(days).length > 0) cleaned.days = days

  const media: Record<string, SlideshowMediaSettings> = {}
  for (const [key, value] of Object.entries(settings.media ?? {})) {
    const entry: SlideshowMediaSettings = {}
    if (
      typeof value.durationMs === 'number' &&
      Number.isFinite(value.durationMs) &&
      value.durationMs > 0
    ) {
      entry.durationMs = Math.round(value.durationMs)
    }
    if (value.excluded) entry.excluded = true
    if (Object.keys(entry).length > 0) media[key] = entry
  }
  if (Object.keys(media).length > 0) cleaned.media = media

  const order: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(settings.order ?? {})) {
    const list = (ids ?? []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )
    if (list.length > 0) order[key] = list
  }
  if (Object.keys(order).length > 0) cleaned.order = order

  const endCard: SlideshowEndCardSettings = {}
  if (typeof settings.endCard?.enabled === 'boolean') {
    endCard.enabled = settings.endCard.enabled
  }
  if (settings.endCard?.title?.trim()) endCard.title = settings.endCard.title
  if (Object.keys(endCard).length > 0) cleaned.endCard = endCard

  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}
