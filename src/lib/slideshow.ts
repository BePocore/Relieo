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

  const endCard: SlideshowEndCardSettings = {}
  if (typeof settings.endCard?.enabled === 'boolean') {
    endCard.enabled = settings.endCard.enabled
  }
  if (settings.endCard?.title?.trim()) endCard.title = settings.endCard.title
  if (Object.keys(endCard).length > 0) cleaned.endCard = endCard

  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}
