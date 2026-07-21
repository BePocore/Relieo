import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Check,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Compass,
  Copy,
  LayoutDashboard,
  List,
  LocateFixed,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Minus,
  Mountain,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react'
import './App.css'
import { BasemapControl } from './components/BasemapControl'
import { MediaRail } from './components/MediaRail'
import { PublicPanel } from './components/PublicPanel'
import { StudioPanel } from './components/StudioPanel'
import { StatsBar } from './components/StatsBar'
import type { CameraCommand } from './components/MapLibreTrailMap'
import { computeTrailStats, distanceBetween } from './lib/geo'
import { parseGpx } from './lib/gpx'
import {
  hydrateProjectTraces,
  serializeTracePoints,
  traceBlobFingerprint,
  tracesForStorage,
} from './lib/traceFiles'
import {
  cleanupUnusedUploadedMedia,
  deleteUploadedMedia,
  fileFingerprint,
  fileFingerprints,
  uploadMedia,
} from './lib/cloudUpload'
// Façade paresseuse : le SDK Firebase ne se télécharge qu'au premier appel
// réel (Studio, sauvegarde), jamais en consultation publique (perf).
import { firebaseEnabled, getIdToken } from './portal/firebaseLazy'
import { requestMediaTicket, startMediaTicketRefresh } from './lib/mediaTicket'
import {
  takeEarlyMediaTicket,
  takeEarlyProjectFetch,
} from './lib/earlyConsultation'
import {
  startMediaPrefetch,
  type MediaPrefetchItem,
} from './lib/mediaPrefetch'
import { reportHealthEvent, reportHealthTiming } from './lib/health'
import { loadUserTraces, type UserTraceRecord } from './portal/userTraces'
import { takePendingTraceImport } from './lib/pendingTraceImport'
import {
  createImportedMedia,
  findPointMediaItem,
  mediaKindFromFile,
  resolvePointMedia,
} from './lib/media'
import {
  DISPLAY_MAX_SIDE,
  createDisplayVariant,
  createMediaPreview,
} from './lib/mediaPreview'
import { buildDayPlan, computeDayStats } from './lib/days'
import {
  ALL_MEDIA_ORDER_KEY,
  END_CARD_DEFAULT_INTRO,
  END_CARD_DEFAULT_TITLE,
  UNDATED_DAY_KEY,
  UNDATED_DEFAULT_INTRO,
  UNDATED_DEFAULT_LABEL,
  applyMediaOrder,
  defaultDayIntro,
  orderMediaByDayTimeTrack,
} from './lib/slideshow'
import { formatDistance, formatGain } from './lib/format'
import { reverseGeocode } from './lib/geocode'
import { DayTimeline } from './components/DayTimeline'
import { SlideshowEditor } from './components/SlideshowEditor'
import { defaultBasemap, type BasemapId } from './lib/basemaps'
import { cleanMapConfig, configBasemap } from './lib/mapConfig'
import {
  googleDriveImportConfigured,
  pickGoogleDriveMedia,
} from './lib/googleDrive'
import type {
  ImportedMedia,
  ImportReport,
  MapConfig,
  MapViewMode,
  MediaKind,
  PointType,
  SlideshowMediaSettings,
  SlideshowSettings,
  Trace,
  TrailPoint,
  TrailProject,
  TrackPoint,
  TrailStats,
  UploadProgress,
} from './types'
import { MediaLightbox } from './components/MediaLightbox'
import { AccessGate } from './components/AccessGate'
import { UnavailableMap } from './components/UnavailableMap'
import { useVideoPosters } from './useVideoPosters'

const MapLibreTrailMap = lazy(() =>
  import('./components/MapLibreTrailMap').then((module) => ({
    default: module.MapLibreTrailMap,
  })),
)

// Tuto de consultation chargé en différé : il ne sert qu'une fois la carte
// prête (monté sous condition mapReady), inutile dans le chemin critique.
const ConsultTutorial = lazy(() =>
  import('./components/ConsultTutorial').then((module) => ({
    default: module.ConsultTutorial,
  })),
)

// Carte de transition entre deux jours dans le diaporama narratif.
export type DayBreakInfo = {
  label: string
  dateLabel: string
  color: string
  intro: string
  distanceLabel?: string
  gainLabel?: string
  mediaCount: number
}

export type LightboxMedia = {
  src: string
  // Original brut, présent seulement quand `src` est une variante allégée
  // (donc différent d'elle) : active le bouton « Pleine résolution ».
  fullSrc?: string
  // Variante ET original déclarés avec leur largeur : le NAVIGATEUR choisit
  // selon la taille d'affichage réelle et la densité de l'écran. Un téléphone
  // prend la variante, un grand écran haute densité prend l'original — sans
  // que personne n'ait à cliquer. Absent si les dimensions sont inconnues.
  srcSet?: string
  kind: MediaKind | '360' | 'day-break'
  title?: string
  // Date de prise (EXIF, ISO) : sert de libellé contextuel à la place d'un nom
  // de fichier générique dans la lightbox.
  takenAt?: string
  // Lieu le plus proche (géocodé dans le Studio) : contexte affiché en priorité.
  placeName?: string
  dayBreak?: DayBreakInfo
  // Durée d'affichage personnalisée en lecture auto (réglages du diaporama),
  // prioritaire sur la durée globale. Ignorée pour les vidéos.
  durationMs?: number
}

// Déclare la variante allégée ET l'original avec leur largeur, pour que le
// navigateur choisisse lui-même selon la taille d'affichage et la densité de
// l'écran (`srcset`). Sans ça, un écran haute densité recevait la variante de
// 2000 px pour l'afficher sur 2800 px réels : image étirée, donc molle.
//
// La largeur de la variante n'est pas stockée : on la recalcule à partir des
// dimensions d'origine et du plafond du générateur (DISPLAY_MAX_SIDE), qui
// réduit le plus grand côté sans déformer. Rien à regénérer côté R2.
const buildDisplaySrcSet = (media: {
  src: string
  displaySrc?: string
  width?: number
  height?: number
}): string | undefined => {
  const { displaySrc, src, width, height } = media
  if (!displaySrc || !width || !height) return undefined
  const scale = Math.min(DISPLAY_MAX_SIDE / width, DISPLAY_MAX_SIDE / height, 1)
  const displayWidth = Math.max(1, Math.round(width * scale))
  // L'original n'est pas plus large que la variante (petite photo) : une seule
  // source suffit, deux candidats identiques n'apporteraient rien.
  if (displayWidth >= width) return undefined
  return `${displaySrc} ${displayWidth}w, ${src} ${width}w`
}

// Construit la liste plein écran (photos / vidéos / 360) à partir de points.
// Réutilisé pour le clic sur un groupe ET le diaporama de toute la page ;
// `mediaSettings` (réglages du diaporama) porte les durées personnalisées.
const pointsToLightboxItems = (
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
  mediaSettings?: Record<string, SlideshowMediaSettings>,
): LightboxMedia[] =>
  points
    .map((point): LightboxMedia | null => {
      const media = resolvePointMedia(point, mediaLibrary)
      if (!media || (media.kind !== 'image' && media.kind !== 'video')) {
        return null
      }
      const kind =
        point.type === '360' && media.kind === 'image' ? '360' : media.kind
      const durationMs = point.id
        ? mediaSettings?.[point.id]?.durationMs
        : undefined
      const takenAt = findPointMediaItem(point, mediaLibrary)?.takenAt
      return {
        src: media.displaySrc ?? media.src,
        // Bouton « Pleine résolution » seulement quand `src` est vraiment une
        // variante allégée (sinon fullSrc === src, rien à gagner à l'afficher).
        ...(media.displaySrc ? { fullSrc: media.src } : {}),
        ...(media.displaySrc ? { srcSet: buildDisplaySrcSet(media) } : {}),
        kind,
        title: point.title,
        ...(takenAt ? { takenAt } : {}),
        ...(point.placeName ? { placeName: point.placeName } : {}),
        ...(durationMs ? { durationMs } : {}),
      }
    })
    .filter((item): item is LightboxMedia => item !== null)

// Reprise du diaporama : si on le quitte, on a 10 min pour revenir et reprendre
// à la même position. La position + l'heure sont stockées en localStorage.
const SLIDESHOW_RESUME_MS = 10 * 60 * 1000
const slideshowResumeKey = (slug: string): string =>
  slug ? `relieo.slideshow.${slug}` : ''

const pointTypes: PointType[] = ['photo', 'video', '360', 'poi']
export const newPointTitle = 'Nouveau point'

type PerfMode = 'auto' | 'force-2d' | 'force-3d'

let traceIdCounter = 0
const createTraceId = (): string => {
  traceIdCounter += 1
  return `trace-${Date.now()}-${traceIdCounter}`
}

// Stats combinées : on additionne chaque trace pour ne pas compter la
// distance entre la fin d'un jour et le départ du suivant.
const combineStats = (traces: Trace[]): TrailStats => {
  let distanceMeters = 0
  let elevationGainMeters = 0
  let elevationLossMeters = 0
  let pointCount = 0
  let maxElevationMeters: number | null = null
  let minElevationMeters: number | null = null

  for (const trace of traces) {
    const stats = computeTrailStats(trace.points)
    distanceMeters += stats.distanceMeters
    elevationGainMeters += stats.elevationGainMeters
    elevationLossMeters += stats.elevationLossMeters
    pointCount += stats.pointCount
    if (stats.maxElevationMeters !== null) {
      maxElevationMeters =
        maxElevationMeters === null
          ? stats.maxElevationMeters
          : Math.max(maxElevationMeters, stats.maxElevationMeters)
    }
    if (stats.minElevationMeters !== null) {
      minElevationMeters =
        minElevationMeters === null
          ? stats.minElevationMeters
          : Math.min(minElevationMeters, stats.minElevationMeters)
    }
  }

  return {
    distanceMeters,
    elevationGainMeters,
    elevationLossMeters,
    maxElevationMeters,
    minElevationMeters,
    pointCount,
  }
}

const isStudioUrl = (): boolean => {
  const params = new URLSearchParams(window.location.search)
  return params.get('mode') === 'studio' || window.location.hash === '#studio'
}

const publicUrl = (slug?: string): string => {
  const url = new URL(window.location.href)
  url.searchParams.delete('mode')
  url.searchParams.delete('new')
  url.searchParams.delete('code')
  if (slug?.trim()) url.searchParams.set('m', slug.trim())
  url.hash = ''
  return `${url.pathname}${url.search}${url.hash}` || '/'
}

const studioUrl = (): string => {
  const url = new URL(window.location.href)
  url.searchParams.set('mode', 'studio')
  url.hash = ''
  return url.toString()
}

// Après la première sauvegarde d'une nouvelle carte, bascule l'URL `?new=<code>`
// en `?code=<code>` pour qu'un rechargement recharge le brouillon enregistré
// (et ne réouvre pas un studio vide).
const syncStudioUrlToCode = (slug: string): void => {
  if (!slug) return
  const url = new URL(window.location.href)
  if (!url.searchParams.has('new')) return
  url.searchParams.delete('new')
  url.searchParams.set('m', slug)
  window.history.replaceState(window.history.state, '', url.toString())
}

const studioReturnStateKey = 'relieoStudioReturn'

const studioReturnUrl = (): string | null => {
  const state = window.history.state as Record<string, unknown> | null
  const candidate = state?.[studioReturnStateKey]
  if (typeof candidate !== 'string') return null

  const url = new URL(candidate, window.location.origin)
  if (
    url.origin !== window.location.origin ||
    url.searchParams.get('mode') !== 'studio'
  ) {
    return null
  }
  return `${url.pathname}${url.search}${url.hash}`
}

const openConsultationFromStudio = (code: string): void => {
  const currentState = window.history.state
  const state =
    currentState && typeof currentState === 'object' ? currentState : {}
  window.history.pushState(
    { ...state, [studioReturnStateKey]: studioUrl() },
    '',
    publicUrl(code),
  )
  window.location.reload()
}

// En-têtes d'auth pour écrire dans R2 : jeton Firebase prioritaire, sinon mot
// de passe admin (compat). null si aucune auth disponible → on n'écrit pas.
const saveAuthHeaders = async (
  adminPassword: string,
): Promise<Record<string, string> | null> => {
  const token = await getIdToken()
  if (token) {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  }
  if (adminPassword) {
    return { 'Content-Type': 'application/json', 'x-admin-password': adminPassword }
  }
  return null
}

// Métadonnées jointes au PUT pour tenir à jour le registre des randos (api/hikes).
const buildIndexMeta = (input: {
  title: string
  code: string
  distanceMeters: number
  elevationGainMeters: number
  pointCount: number
  mediaCount: number
  status: 'draft' | 'published'
}): Record<string, unknown> => ({
  title: input.title || input.code || 'Carte',
  hikeStatus: input.status,
  distanceKm: Math.round((input.distanceMeters / 1_000) * 10) / 10,
  elevationGain: Math.round(input.elevationGainMeters),
  pointCount: input.pointCount,
  mediaCount: input.mediaCount,
})

const normalizePoint = (point: TrailPoint, index: number): TrailPoint | null => {
  const lat = Number(point.lat)
  const lng = Number(point.lng)

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  return {
    ...point,
    id: point.id ?? `imported-${index}`,
    lat,
    lng,
    title: point.title?.trim() || `Point ${index + 1}`,
    type: pointTypes.includes(point.type) ? point.type : 'poi',
  }
}

const exportablePoints = (points: TrailPoint[]): TrailPoint[] => {
  return points.map((point) => {
    const cleanPoint: TrailPoint = {
      id: point.id,
      lat: point.lat,
      lng: point.lng,
      title: point.title,
      type: point.type,
      ...(point.description ? { description: point.description } : {}),
      ...(point.skypixelUrl ? { skypixelUrl: point.skypixelUrl } : {}),
      ...(point.altitude !== undefined ? { altitude: point.altitude } : {}),
      ...(point.color ? { color: point.color } : {}),
      ...(point.placeName ? { placeName: point.placeName } : {}),
    }

    if (point.video) {
      cleanPoint.video = point.video.startsWith('blob:') && point.mediaName
        ? `/videos/${point.mediaName}`
        : point.video
    } else if (point.image) {
      cleanPoint.image = point.image.startsWith('blob:') && point.mediaName
        ? `/photos/${point.mediaName}`
        : point.image
    }

    return cleanPoint
  })
}

const projectSignature = (input: {
  points: TrailPoint[]
  traces: Trace[]
  mediaLibrary: ImportedMedia[]
  accessCode: string
  pointsSourceName: string
  slideshow: SlideshowSettings | undefined
  mapConfig: MapConfig
}): string =>
  JSON.stringify({
    points: exportablePoints(input.points),
    traces: input.traces,
    mediaLibrary: input.mediaLibrary,
    accessCode: input.accessCode.trim(),
    pointsSourceName: input.pointsSourceName,
    slideshow: input.slideshow ?? null,
    // Normalisé (défauts retirés) pour rester stable entre chargement et état.
    mapConfig: cleanMapConfig(input.mapConfig) ?? null,
  })

const normalizeProject = (
  candidate: Partial<TrailProject>,
): TrailProject | null => {
  if (!Array.isArray(candidate.track) || !Array.isArray(candidate.points)) {
    return null
  }

  return {
    track: candidate.track,
    points: candidate.points,
    traces: Array.isArray(candidate.traces) ? candidate.traces : undefined,
    accessCode:
      typeof candidate.accessCode === 'string' ? candidate.accessCode : undefined,
    mediaLibrary: Array.isArray(candidate.mediaLibrary)
      ? candidate.mediaLibrary
      : [],
    trackSourceName: candidate.trackSourceName ?? 'carte publiee en ligne',
    pointsSourceName: candidate.pointsSourceName ?? 'carte publiee en ligne',
    savedAt: candidate.savedAt ?? new Date().toISOString(),
    slideshow:
      candidate.slideshow &&
      typeof candidate.slideshow === 'object' &&
      !Array.isArray(candidate.slideshow)
        ? candidate.slideshow
        : undefined,
    mapConfig:
      candidate.mapConfig &&
      typeof candidate.mapConfig === 'object' &&
      !Array.isArray(candidate.mapConfig)
        ? candidate.mapConfig
        : undefined,
  }
}

const friendlyStorageMessage = (message: string): string => {
  return /403|blocked|suspended|limits|sature/i.test(message)
    ? 'Stockage Cloudflare R2 saturé. Les fichiers en échec doivent être réimportés.'
    : message
}

// Nombre d'envois simultanes vers le stockage lors d'un import groupe.
const uploadConcurrency = 1

// Seuil au-delà duquel un média géolocalisé est jugé « hors tracé ».
// Adaptatif : proportionnel à l'emprise de la trace, plancher à 3 km.
const offTrackThresholdMeters = (track: TrackPoint[]): number => {
  if (track.length < 2) return Number.POSITIVE_INFINITY

  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const point of track) {
    if (point.lat < minLat) minLat = point.lat
    if (point.lat > maxLat) maxLat = point.lat
    if (point.lng < minLng) minLng = point.lng
    if (point.lng > maxLng) maxLng = point.lng
  }

  const diagonal = distanceBetween(
    { lat: minLat, lng: minLng },
    { lat: maxLat, lng: maxLng },
  )
  return Math.max(3_000, diagonal * 0.75)
}

const distanceToTrack = (
  target: Pick<TrackPoint, 'lat' | 'lng'>,
  track: TrackPoint[],
): number => {
  let nearest = Number.POSITIVE_INFINITY
  for (const point of track) {
    const distance = distanceBetween(target, point)
    if (distance < nearest) nearest = distance
  }
  return nearest
}

const formatKilometers = (meters: number): string => {
  if (meters < 1_000) return `${Math.round(meters)} m`
  return `${(meters / 1_000).toLocaleString('fr-FR', {
    maximumFractionDigits: 1,
  })} km`
}

const mediaAlreadyInLibrary = (
  library: ImportedMedia[],
  media: ImportedMedia,
): boolean => {
  return library.some(
    (item) =>
      item.id === media.id ||
      item.url === media.url ||
      Boolean(media.fingerprint && item.fingerprint === media.fingerprint),
  )
}

const pointUsesMedia = (point: TrailPoint, media: ImportedMedia): boolean => {
  return (
    point.image === media.url ||
    point.video === media.url ||
    point.mediaName?.toLowerCase() === media.name.toLowerCase()
  )
}

const pointTypeAfterMediaRemoval = (point: TrailPoint): PointType => {
  if (point.skypixelUrl) return '360'
  return point.type === 'photo' || point.type === 'video' || point.type === '360'
    ? 'poi'
    : point.type
}

const stripMediaFromPoint = (
  point: TrailPoint,
  media: ImportedMedia,
): TrailPoint => {
  if (!pointUsesMedia(point, media)) return point
  return {
    ...point,
    type: pointTypeAfterMediaRemoval(point),
    image: undefined,
    video: undefined,
    mediaName: undefined,
    mediaKind: undefined,
  }
}

const mediaUrlsUsedByPoints = (
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
): string[] => {
  const urls = new Set<string>()
  for (const point of points) {
    if (point.image) urls.add(point.image)
    if (point.video) urls.add(point.video)
  }
  for (const media of mediaLibrary) {
    if (!points.some((point) => pointUsesMedia(point, media))) continue
    urls.add(media.url)
    if (media.thumbnailUrl) urls.add(media.thumbnailUrl)
    if (media.displayUrl) urls.add(media.displayUrl)
  }
  return Array.from(urls)
}

const pruneMediaFromImportReport = (
  report: ImportReport | null,
  removedMedia: ImportedMedia[],
): ImportReport | null => {
  if (!report || removedMedia.length === 0) return report
  const removedIds = new Set(removedMedia.map((media) => media.id))
  const removedNames = new Set(
    removedMedia.map((media) => media.name.toLowerCase()),
  )
  const keepEntry = (entry: ImportReport['placed'][number]): boolean => {
    if (entry.mediaId && removedIds.has(entry.mediaId)) return false
    return !removedNames.has(entry.name.toLowerCase())
  }
  const next: ImportReport = {
    total: 0,
    placed: report.placed.filter(keepEntry),
    noGps: report.noGps.filter(keepEntry),
    offTrack: report.offTrack.filter(keepEntry),
    duplicates: report.duplicates.filter(keepEntry),
    failed: report.failed.filter(keepEntry),
  }
  next.total =
    next.placed.length +
    next.noGps.length +
    next.offTrack.length +
    next.duplicates.length +
    next.failed.length
  return next.total > 0 ? next : null
}

function App() {
  const [isStudioMode] = useState(() => isStudioUrl())
  // Carte ouverte depuis le feed social (`&from=feed`) : on propose un retour au
  // feed en consultation (comme le retour au dashboard depuis le Studio).
  const [fromFeed] = useState(
    () => new URLSearchParams(window.location.search).get('from') === 'feed',
  )
  const [studioReturnHref] = useState(() =>
    isStudioUrl() ? null : studioReturnUrl(),
  )
  const [newTrailCode] = useState(() =>
    new URLSearchParams(window.location.search).get('new')?.trim() ?? '',
  )
  // Type choisi à la création d'une carte vierge (`&kind=gallery`) : posé dans
  // mapConfig au démarrage du Studio vide, persisté à la première sauvegarde.
  const [newMapKindParam] = useState(
    () => new URLSearchParams(window.location.search).get('kind')?.trim() ?? '',
  )
  // Carte ouverte par son identifiant d'URL opaque : `?m=<slug>` (ou `?code=`
  // legacy). Le propriétaire est toujours déduit du jeton Firebase côté API.
  const [hikeCode] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return (params.get('m') ?? params.get('code'))?.trim() ?? ''
  })
  const [hikeTitle, setHikeTitle] = useState(() =>
    new URLSearchParams(window.location.search).get('title')?.trim() ?? '',
  )
  // Nouvelle carte vierge : `?new=<slug>` démarre un studio VIDE (en dev comme
  // en prod). La carte reste un brouillon (autosave en draft) jusqu'à publication.
  const isNewBlankStudio = Boolean(newTrailCode)
  // Identité UNIQUE de la carte côté client : le slug opaque. Sert à l'URL de
  // partage, au ticket média et au dossier de stockage (folder = trailFolder(slug)).
  const mapSlug = hikeCode || newTrailCode
  const [isPanelOpen, setIsPanelOpen] = useState(() => isStudioUrl())
  const [traces, setTraces] = useState<Trace[]>([])
  const [points, setPoints] = useState<TrailPoint[]>([])
  const [mediaLibrary, setMediaLibrary] = useState<ImportedMedia[]>([])
  const [basemap, setBasemap] = useState<BasemapId>(defaultBasemap)
  const [selectedPoint, setSelectedPoint] = useState<TrailPoint | null>(null)
  // Jour sélectionné dans la timeline des jours (consultation). null = séjour
  // complet. Filtré à l'usage : si le plan change et ne contient plus ce jour,
  // il est ignoré (retombe sur null).
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null)
  const [recenterRequest, setRecenterRequest] = useState(0)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Voile plein écran tant que la carte n'est pas prête. `tilesReady` = tuiles
  // de carte chargées ; `mapReady` ajoute l'attente des posters vidéo (plafonnée,
  // cf. POSTERS_TIMEOUT_MS plus bas) pour que les marqueurs vidéo n'apparaissent
  // pas après coup. Les marqueurs photo utilisent la vignette serveur
  // (thumbnailUrl), quasi instantanée : aucune attente client ne les concerne.
  const [tilesReady, setTilesReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const settleTimerRef = useRef<number | null>(null)
  // Instant de montage : sert au mini-RUM (temps de chargement réel remonté
  // au monitoring santé, cf. l'effet de timing plus bas). Posé dans un effet
  // (pas à l'init du ref) : `performance.now()` est impur, interdit pendant
  // le rendu par ce lint (react-hooks/purity).
  const bootTimeRef = useRef(0)
  useEffect(() => {
    bootTimeRef.current =
      typeof performance !== 'undefined' ? performance.now() : Date.now()
  }, [])
  const timingReportedRef = useRef(false)
  // Diagnostic du voile bloqué, tenu à jour par un effet dédié (cf. plus bas)
  // et relu uniquement au déclenchement du chien de garde à 25 s.
  const veilDiagRef = useRef({
    tilesReady: false,
    postersReady: false,
    imageCount: 0,
    videoCount: 0,
  })
  // Le relief reste le mode principal, avec une vue 2D manuelle si nécessaire.
  const [perfMode, setPerfMode] = useState<PerfMode>('auto')
  // Réglages de la carte (persistés dans project.json) : type (figé à la
  // création), mode de vue 2D/3D, fond par défaut. Objet vide = défauts.
  const [mapConfig, setMapConfig] = useState<MapConfig>({})
  const isGalleryMap = mapConfig.kind === 'gallery'
  const mapViewMode: MapViewMode =
    mapConfig.viewMode === '2d' || mapConfig.viewMode === '3d'
      ? mapConfig.viewMode
      : 'both'
  // Vue verrouillée par carte : '2d'/'3d' ignorent le cycle Auto/2D/3D (dont
  // le badge est alors masqué) ; 'both' = comportement historique.
  const mapFlat2D =
    mapViewMode === '2d'
      ? true
      : mapViewMode === '3d'
        ? false
        : perfMode === 'force-2d'
  const [isSaving, setIsSaving] = useState(false)
  // Statut de publication de la carte courante : une carte reste un brouillon
  // (autosave en draft) jusqu'à publication explicite. Une carte chargée déjà
  // publiée le reste.
  const [isPublished, setIsPublished] = useState(false)
  const [isAutosaving, setIsAutosaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isDriveImporting, setIsDriveImporting] = useState(false)
  const [isCleaningUnusedMedia, setIsCleaningUnusedMedia] = useState(false)
  const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  )
  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const [manualPlacementMediaId, setManualPlacementMediaId] = useState<
    string | null
  >(null)
  const [lightbox, setLightbox] = useState<{
    items: LightboxMedia[]
    index: number
    // Clé localStorage de reprise (diaporama seulement) : la position et l'heure
    // y sont mémorisées pour reprendre là où on s'est arrêté (fenêtre 10 min).
    persistKey?: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Échec du chargement initial d'une carte (code inconnu ou brouillon non
  // accessible) : déclenche l'écran « indisponible » côté visiteur.
  const [loadFailed, setLoadFailed] = useState(false)
  // Chien de garde du voile de chargement : passe à true si le voile est encore
  // là après un long délai, pour proposer un bouton « Recharger » plutôt que de
  // laisser le visiteur bloqué sans issue (cf. vieil onglet après déploiement).
  const [loaderStuck, setLoaderStuck] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [adminPassword, setAdminPassword] = useState('')
  const [pointsSourceName, setPointsSourceName] = useState('/data/points.json')
  // `accessCode` = le CODE D'ACCÈS SECRET (write-only). Vide au chargement (on
  // ne le relit jamais) ; le propriétaire en pose un nouveau dans le Studio.
  const [accessCode, setAccessCode] = useState('')
  // Visibilité de la carte : 'private' = protégée par un code, 'public' = lien
  // direct sans code. Défaut privé (le portail crée privé par défaut).
  const [accessMode, setAccessMode] = useState<'public' | 'private'>('private')
  // La carte a-t-elle déjà un code posé côté serveur ? (garde de sauvegarde :
  // interdit de passer « privée » sans code.)
  const [isProtected, setIsProtected] = useState(false)
  // URLs des médias non encore validés par la modération : badge « vérification
  // en cours » dans le studio (le propriétaire les voit, le public non).
  const [moderationPending, setModerationPending] = useState<string[]>([])
  const [accessGranted, setAccessGranted] = useState(false)
  // Carte protégée dont le contenu n'est pas encore livré (le serveur n'a renvoyé
  // que des métadonnées) → on affiche l'écran de saisie du code.
  const [protectedGate, setProtectedGate] = useState(false)
  // Code d'accès validé par le VISITEUR (non propriétaire) : conservé le temps de
  // la session pour renouveler le ticket média (~toutes les 60 s). Jamais persisté.
  const visitorCodeRef = useRef('')
  const [copied, setCopied] = useState(false)
  const [savedProjectSignature, setSavedProjectSignature] = useState<string | null>(
    null,
  )
  // Réglages du diaporama (persistés dans project.json, édités au Studio).
  const [slideshowSettings, setSlideshowSettings] = useState<
    SlideshowSettings | undefined
  >(undefined)
  const [showSlideshowEditor, setShowSlideshowEditor] = useState(false)
  const [hasPanelDraft, setHasPanelDraft] = useState(false)
  const [showDashboardConfirm, setShowDashboardConfirm] = useState(false)
  const isGoogleDriveConfigured = googleDriveImportConfigured()

  // Fichiers R2 des traces telles que chargées : sert à supprimer, à la
  // sauvegarde, les fichiers des traces retirées entre-temps dans le Studio.
  const loadedTraceUrlsRef = useRef<string[]>([])

  const applyProject = useCallback((project: TrailProject) => {
    const loadedTraces =
      project.traces && project.traces.length > 0
        ? project.traces.filter(
            (trace) => Array.isArray(trace.points) && trace.points.length > 1,
          )
        : [
            {
              id: createTraceId(),
              name: project.trackSourceName,
              points: project.track,
            },
          ]
    loadedTraceUrlsRef.current = loadedTraces
      .map((trace) => trace.fileUrl)
      .filter((url): url is string => Boolean(url))
    const loadedPoints = project.points
      .map((point, index) => normalizePoint(point, index))
      .filter((point): point is TrailPoint => point !== null)
    const loadedMediaLibrary = project.mediaLibrary ?? []
    const loadedMapConfig = project.mapConfig ?? {}
    setTraces(loadedTraces)
    setPoints(loadedPoints)
    setMediaLibrary(loadedMediaLibrary)
    setPointsSourceName(project.pointsSourceName)
    setSlideshowSettings(project.slideshow)
    setMapConfig(loadedMapConfig)
    // Fond d'ouverture choisi pour cette carte (le sélecteur reste disponible).
    setBasemap(configBasemap(loadedMapConfig))
    // Le code d'accès est write-only : jamais renvoyé par le serveur, donc vide
    // au chargement. Le propriétaire en pose un nouveau dans le Studio au besoin.
    setAccessCode('')
    setSavedProjectSignature(
      projectSignature({
        points: loadedPoints,
        traces: loadedTraces,
        mediaLibrary: loadedMediaLibrary,
        accessCode: '',
        pointsSourceName: project.pointsSourceName,
        slideshow: project.slideshow,
        mapConfig: loadedMapConfig,
      }),
    )
    // Le contenu complet est là (métadonnées seules n'appellent pas applyProject).
    setAccessGranted(true)
    setProtectedGate(false)
    setSelectedPoint(null)
  }, [])

  useEffect(() => {
    const loadTrail = async () => {
      try {
        setIsLoading(true)
        setError(null)
        setLoadFailed(false)

        if (isNewBlankStudio) {
          const blankPoints: TrailPoint[] = []
          const blankTraces: Trace[] = []
          const blankMediaLibrary: ImportedMedia[] = []
          const blankPointsSourceName = 'Nouveau projet local'
          // Code d'accès secret choisi à la création, transmis via sessionStorage
          // (jamais par l'URL). Consommé une fois puis effacé.
          let newSecret = ''
          try {
            const key = `relieo.newMapCode.${newTrailCode}`
            newSecret = sessionStorage.getItem(key) ?? ''
            sessionStorage.removeItem(key)
          } catch {
            newSecret = ''
          }
          // Type choisi à la création (URL `&kind=`), figé ensuite.
          const blankMapConfig: MapConfig =
            newMapKindParam === 'gallery' ? { kind: 'gallery' } : {}
          setTraces(blankTraces)
          setPoints(blankPoints)
          setMediaLibrary(blankMediaLibrary)
          setPointsSourceName(blankPointsSourceName)
          setSlideshowSettings(undefined)
          setMapConfig(blankMapConfig)
          setAccessCode(newSecret)
          // Un code choisi à la création ⇒ carte privée ; code vide ⇒ publique.
          setAccessMode(newSecret ? 'private' : 'public')
          setIsProtected(Boolean(newSecret))
          setModerationPending([])
          setSavedProjectSignature(
            projectSignature({
              points: blankPoints,
              traces: blankTraces,
              mediaLibrary: blankMediaLibrary,
              accessCode: newSecret,
              pointsSourceName: blankPointsSourceName,
              slideshow: undefined,
              mapConfig: blankMapConfig,
            }),
          )
          setAccessGranted(true)
          setSelectedPoint(null)
          setIsPublished(false)
          return
        }

        // Avec un slug → on charge CETTE carte via `?m=`. Sans slug → carte
        // active (en dev, lue depuis la prod via le proxy).
        const projectEndpoint = hikeCode
          ? `/api/project?m=${encodeURIComponent(hikeCode)}`
          : import.meta.env.DEV
            ? '/prototype-api/project'
            : '/api/project'
        // Jeton Firebase envoyé UNIQUEMENT dans le Studio : le propriétaire (ou
        // l'admin) peut y recharger un brouillon, que le serveur ne sert
        // qu'authentifié. En consultation publique, pas de jeton : un brouillon
        // reste inaccessible par son lien, même pour son auteur connecté.
        const authToken =
          hikeCode && isStudioMode ? await getIdToken() : null
        // Consultation publique : la réponse préchargée depuis le chunk
        // d'entrée (Root, earlyConsultation) est consommée si elle correspond ;
        // un échec du préchargement retombe sur une requête normale.
        const earlyResponse = authToken
          ? null
          : takeEarlyProjectFetch(projectEndpoint)
        let projectResponse = earlyResponse ? await earlyResponse : null
        if (!projectResponse) {
          projectResponse = await fetch(projectEndpoint, {
            cache: 'no-store',
            credentials: 'include',
            headers: authToken
              ? { Authorization: `Bearer ${authToken}` }
              : undefined,
          }).catch(() => null)
        }

        let onlineProject: TrailProject | null = null
        let onlineError: string | null = null
        const projectContentType = projectResponse?.headers.get('content-type')

        if (
          projectResponse?.ok &&
          projectContentType?.includes('application/json')
        ) {
          const raw = (await projectResponse.json()) as Partial<TrailProject> & {
            hikeStatus?: string
            protected?: boolean
            title?: string
            isProtected?: boolean
            moderationPending?: string[]
          }
          // Carte PROTÉGÉE non déverrouillée : le serveur ne renvoie que des
          // métadonnées (pas de `points`). On affiche l'écran de saisie du code,
          // sans charger de contenu ni demander de ticket média.
          if (raw.protected === true && !Array.isArray(raw.points)) {
            if (typeof raw.title === 'string' && raw.title) setHikeTitle(raw.title)
            setIsPublished(raw.hikeStatus !== 'draft')
            setProtectedGate(true)
            setAccessGranted(false)
            setIsLoading(false)
            return
          }
          // Une carte déjà chargée est considérée publiée sauf statut draft
          // explicite (les cartes historiques sans statut restent publiées).
          setIsPublished(raw.hikeStatus !== 'draft')
          // Visibilité + médias en attente de modération (renvoyés au
          // propriétaire/admin uniquement ; un visiteur ne les reçoit pas).
          setAccessMode(raw.isProtected ? 'private' : 'public')
          setIsProtected(Boolean(raw.isProtected))
          setModerationPending(
            Array.isArray(raw.moderationPending) ? raw.moderationPending : [],
          )
          onlineProject = normalizeProject(raw)
        } else if (projectResponse) {
          const result = (await projectResponse.json().catch(() => null)) as {
            message?: string
          } | null
          onlineError = result?.message ?? 'Carte en ligne indisponible.'
        }

        if (!onlineProject) {
          throw new Error(onlineError ?? 'Aucune carte disponible dans Cloudflare R2.')
        }
        // Ticket d'acces media (cookie pose) AVANT d'afficher, pour que les images
        // partent deja autorisees : en consultation (public) comme en Studio
        // (ticket proprietaire via le jeton Firebase deja recupere ci-dessus).
        // Le ticket precharge en parallele depuis Root est reutilise s'il a
        // abouti ; sinon (echec, Studio) demande classique.
        if (mapSlug) {
          const earlyTicket = authToken ? null : takeEarlyMediaTicket(mapSlug)
          const earlyTicketOk = earlyTicket ? await earlyTicket : null
          if (earlyTicketOk === null) {
            await requestMediaTicket({ code: mapSlug }, authToken)
          }
        }
        // Traces au nouveau format (fichiers R2) : rechargées via le videur (le
        // cookie ticket vient d'être posé) avant d'afficher la carte. Les
        // anciennes cartes (points inline) passent telles quelles.
        const hydrated = await hydrateProjectTraces(onlineProject)
        applyProject(hydrated.project)
        if (hydrated.missingCount > 0) {
          setError(
            `${hydrated.missingCount} trace(s) n'ont pas pu être rechargées.`,
          )
        }
        // Trace en attente depuis l'onglet Traces : ajoutee a CETTE carte (non
        // sauvegardee), le proprietaire relit puis clique Sauvegarder.
        const pending = takePendingTraceImport()
        if (
          pending &&
          pending.code === hikeCode &&
          pending.points.length >= 2
        ) {
          setTraces((current) => [
            ...current,
            {
              id: createTraceId(),
              name: pending.name,
              points: pending.points,
            },
          ])
        }
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Chargement impossible.',
        )
        setLoadFailed(true)
      } finally {
        setIsLoading(false)
      }
    }

    void loadTrail()
  }, [
    applyProject,
    isNewBlankStudio,
    newMapKindParam,
    newTrailCode,
    hikeCode,
    isStudioMode,
    mapSlug,
  ])

  // Renouvellement du ticket d'acces media (~mi-vie) tant que la carte reste
  // ouverte. Le tout premier ticket est obtenu au chargement (ou à la validation
  // du code). On ne renouvelle pas tant qu'une carte protégée n'est pas ouverte.
  useEffect(() => {
    if (!mapSlug) return
    if (protectedGate && !accessGranted) return
    // Carte protégée déverrouillée par un visiteur : on renouvelle en renvoyant
    // le code validé. En Studio, on re-signe avec le jeton Firebase (propriétaire).
    const req = visitorCodeRef.current
      ? { code: mapSlug, accessCode: visitorCodeRef.current }
      : { code: mapSlug }
    return startMediaTicketRefresh(
      req,
      isStudioMode ? getIdToken : undefined,
    )
  }, [isStudioMode, mapSlug, protectedGate, accessGranted])

  const combinedPoints = useMemo(
    () => traces.flatMap((trace) => trace.points),
    [traces],
  )
  const timedTracePoints = useMemo(
    () =>
      combinedPoints
        .map((point) => ({
          point,
          timestamp: point.time ? Date.parse(point.time) : Number.NaN,
        }))
        .filter(({ timestamp }) => Number.isFinite(timestamp)),
    [combinedPoints],
  )
  const canEstimatePlacement = timedTracePoints.length > 0
  const manualPlacementMedia = useMemo(
    () =>
      manualPlacementMediaId
        ? mediaLibrary.find((media) => media.id === manualPlacementMediaId) ??
          null
        : null,
    [manualPlacementMediaId, mediaLibrary],
  )
  useEffect(() => {
    if (!manualPlacementMediaId) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setManualPlacementMediaId(null)
      setSaveStatus('Placement manuel annule.')
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [manualPlacementMediaId])
  const stats = useMemo(() => combineStats(traces), [traces])
  // Plan de journées (voyages multi-jours) : entièrement dérivé des données
  // chargées (EXIF, horodatages GPX...), rien n'est persisté.
  const dayPlan = useMemo(
    () => buildDayPlan(traces, points, mediaLibrary),
    [traces, points, mediaLibrary],
  )
  // Jour actif réellement appliqué : ignoré si le plan ne le contient plus
  // (changement de carte, trace supprimée...).
  const activeDayKey = useMemo(
    () =>
      selectedDayKey !== null &&
      dayPlan.days.some((day) => day.key === selectedDayKey)
        ? selectedDayKey
        : null,
    [selectedDayKey, dayPlan],
  )
  const handleSelectDay = useCallback((key: string | null) => {
    setSelectedDayKey(key)
  }, [])
  const currentProjectSignature = useMemo(
    () =>
      projectSignature({
        points,
        traces,
        mediaLibrary,
        accessCode,
        pointsSourceName,
        slideshow: slideshowSettings,
        mapConfig,
      }),
    [
      accessCode,
      mapConfig,
      mediaLibrary,
      points,
      pointsSourceName,
      slideshowSettings,
      traces,
    ],
  )
  const usedMediaUrls = useMemo(
    () => mediaUrlsUsedByPoints(points, mediaLibrary),
    [mediaLibrary, points],
  )
  const hasUnsavedProjectChanges =
    savedProjectSignature !== null &&
    currentProjectSignature !== savedProjectSignature
  const { posters: videoPosters, ready: postersReady } = useVideoPosters(
    points,
    mediaLibrary,
  )

  // Plafond d'attente des posters vidéo (2026-07-20) : `useVideoPosters`
  // livre son lot d'un bloc (Promise.all), donc une seule vidéo lente
  // (chargement + décodage + capture d'image) retient TOUTES les autres
  // derrière elle. Sur une carte riche en vidéos (Lofoten, 48 vidéos), ça
  // pouvait bloquer le voile plusieurs dizaines de secondes pour un gain
  // cosmétique (éviter que les marqueurs vidéo « poppent » après coup, cf.
  // commit `19c5e07` du 2026-06-14). Passé ce délai, on révèle quand même :
  // les marqueurs photo (vignettes serveur, quasi instantanées) sont déjà là,
  // les marqueurs vidéo sans poster prêt suivront en tâche de fond dès que
  // `videoPosters` se met à jour (MapLibreTrailMap les redessine alors).
  const POSTERS_TIMEOUT_MS = 4_000
  const [postersTimedOut, setPostersTimedOut] = useState(false)
  useEffect(() => {
    if (!tilesReady || postersReady) return
    const timer = window.setTimeout(
      () => setPostersTimedOut(true),
      POSTERS_TIMEOUT_MS,
    )
    return () => window.clearTimeout(timer)
  }, [tilesReady, postersReady])

  // On lève le voile quand les tuiles de carte sont prêtes ET que les posters
  // vidéo sont soit finis, soit au-delà du plafond ci-dessus. Un court délai
  // de stabilisation évite un flash pendant l'installation des marqueurs.
  const assetsReady = postersReady || postersTimedOut

  // « Dernière valeur connue », relue par le chien de garde au moment où il se
  // déclenche (25 s plus tard). Effet SÉPARÉ de celui du chien de garde : ce
  // dernier doit garder `[veilDone]` comme SEULE dépendance (sinon un flip de
  // `tilesReady`/`postersReady` à 20 s repousserait le minuteur de 25 s à
  // chaque fois, cassant le délai vérifié de bout en bout) — cet effet-ci, lui,
  // peut se re-déclencher librement, il ne fait qu'écrire une ref.
  useEffect(() => {
    veilDiagRef.current = {
      tilesReady,
      postersReady,
      imageCount: mediaLibrary.filter((m) => m.kind === 'image').length,
      videoCount: mediaLibrary.filter((m) => m.kind === 'video').length,
    }
  }, [tilesReady, postersReady, mediaLibrary])

  useEffect(() => {
    if (!tilesReady || mapReady) return
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
    }
    if (!assetsReady) return
    settleTimerRef.current = window.setTimeout(() => setMapReady(true), 300)
    return () => {
      if (settleTimerRef.current !== null) {
        window.clearTimeout(settleTimerRef.current)
      }
    }
  }, [tilesReady, mapReady, assetsReady])

  // Chien de garde du voile : si après 25 s le chargement n'a toujours pas
  // abouti (carte non prête, pas de porte de code, pas d'échec détecté), on
  // propose un bouton « Recharger ». Filet de sécurité universel : quelle qu'en
  // soit la cause (réseau très lent, tuiles externes muettes, état périmé), le
  // visiteur n'est jamais bloqué indéfiniment sans issue.
  const veilDone =
    mapReady ||
    (!isStudioMode && protectedGate && !accessGranted) ||
    loadFailed
  useEffect(() => {
    // Le voile est levé (ou n'a jamais démarré) : rien à surveiller. On ne
    // remet pas `loaderStuck` à false ici (setState synchrone proscrit) — c'est
    // inutile : il ne passe à true qu'après 25 s de voile continu, un état
    // terminal (soit l'utilisateur recharge, soit la carte finit par s'afficher
    // et le voile est masqué). Le rendu combine de toute façon avec !loaderDone.
    if (veilDone) return
    const timer = window.setTimeout(() => {
      setLoaderStuck(true)
      // État EXACT de ce qui bloquait, pour ne plus deviner après coup (cf.
      // l'incident Lofoten du 2026-07-20 : deux visiteurs bloqués/plantés,
      // aucune trace de ce qu'ils vivaient réellement). Lu depuis la ref (la
      // valeur au moment du tir, 25 s après le montage de cet effet).
      reportHealthEvent('veil-stuck', {
        detail: {
          ...veilDiagRef.current,
          connection:
            (navigator as { connection?: { effectiveType?: string } })
              .connection?.effectiveType ?? undefined,
          screen: `${window.innerWidth}x${window.innerHeight}`,
        },
      })
    }, 25_000)
    return () => window.clearTimeout(timer)
  }, [veilDone])

  // Mini-RUM : temps de chargement réel jusqu'à la levée du voile (ou échec),
  // pour savoir ce que vivent les vrais visiteurs au lieu d'extrapoler depuis
  // un audit Playwright sur un PC. Jamais en Studio (chargement authentifié,
  // pas comparable). Un seul envoi par montage (`timingReportedRef`).
  useEffect(() => {
    if (isStudioMode || timingReportedRef.current) return
    if (!mapReady && !loadFailed) return
    timingReportedRef.current = true
    const elapsedMs = Math.round(
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
        bootTimeRef.current,
    )
    reportHealthTiming(elapsedMs, loadFailed ? 'failed' : 'ready')
  }, [isStudioMode, mapReady, loadFailed])

  // Ordre par défaut des médias (diaporama + bandeau du bas) : CHRONOLOGIQUE
  // par jour (heure de prise EXIF), pour raconter le déroulé du voyage. Les
  // médias sans heure de prise gardent leur ordre le long du tracé (repli).
  const mediaPoints = useMemo(() => {
    const filtered = points.filter(
      (point) =>
        point.type === 'photo' ||
        point.type === 'video' ||
        point.type === '360' ||
        Boolean(point.image || point.video || point.skypixelUrl),
    )
    if (filtered.length === 0) return filtered

    // Route avec distance cumulée continue (trace 1 puis trace 2 ...) : sert de
    // repli d'ordre pour les médias sans heure et à départager les ex æquo.
    const route: Array<{ lat: number; lng: number; cum: number }> = []
    let cum = 0
    for (const trace of traces) {
      trace.points.forEach((tracePoint, index) => {
        if (index > 0) cum += distanceBetween(trace.points[index - 1], tracePoint)
        route.push({ lat: tracePoint.lat, lng: tracePoint.lng, cum })
      })
    }
    const trackKey = (point: TrailPoint): number => {
      if (route.length === 0) return 0
      let nearest = Number.POSITIVE_INFINITY
      let key = 0
      for (const routePoint of route) {
        const d = distanceBetween(point, routePoint)
        if (d < nearest) {
          nearest = d
          key = routePoint.cum
        }
      }
      return key
    }
    const trackKeyByPoint = new Map<TrailPoint, number>()
    filtered.forEach((point) => trackKeyByPoint.set(point, trackKey(point)))

    // Heure de prise (EXIF) par point.
    const takenMsByPoint = new Map<TrailPoint, number | null>()
    filtered.forEach((point) => {
      const takenAt = findPointMediaItem(point, mediaLibrary)?.takenAt
      const ms = takenAt ? Date.parse(takenAt) : NaN
      takenMsByPoint.set(point, Number.isNaN(ms) ? null : ms)
    })

    // Rang du jour de chaque point (les jours du plan sont déjà chronologiques ;
    // les médias non datés viennent en dernier).
    const dayOrdinal = new Map<string, number>()
    dayPlan.days.forEach((day, index) => dayOrdinal.set(day.key, index))
    const undatedOrdinal = dayPlan.days.length
    const dayRankByPoint = new Map<TrailPoint, number>()
    points.forEach((point, index) => {
      if (!trackKeyByPoint.has(point)) return
      const key = dayPlan.pointDayKeys[index] ?? null
      dayRankByPoint.set(
        point,
        key === null ? undatedOrdinal : (dayOrdinal.get(key) ?? undatedOrdinal),
      )
    })

    // Tri : jour, puis heure de prise (datés avant non datés), puis tracé.
    return orderMediaByDayTimeTrack(filtered, (point) => ({
      day: dayRankByPoint.get(point) ?? undatedOrdinal,
      takenMs: takenMsByPoint.get(point) ?? null,
      track: trackKeyByPoint.get(point) ?? 0,
    }))
  }, [points, traces, dayPlan, mediaLibrary])

  // Ordre des médias tel qu'affiché : ordre chrono par défaut + réordonnancement
  // custom du Studio appliqué par journée (même ordre que le diaporama, mais
  // médias masqués inclus). Alimente le bandeau du bas pour qu'il colle au diapo.
  const orderedMediaPoints = useMemo<TrailPoint[]>(() => {
    const order = slideshowSettings?.order
    if (!order || Object.keys(order).length === 0) return mediaPoints
    if (!dayPlan.multiDay) {
      return applyMediaOrder(mediaPoints, order[ALL_MEDIA_ORDER_KEY])
    }
    const dayKeyByPoint = new Map<TrailPoint, string | null>()
    points.forEach((point, index) => {
      dayKeyByPoint.set(point, dayPlan.pointDayKeys[index] ?? null)
    })
    const out: TrailPoint[] = []
    dayPlan.days.forEach((day) => {
      out.push(
        ...applyMediaOrder(
          mediaPoints.filter((point) => dayKeyByPoint.get(point) === day.key),
          order[day.key],
        ),
      )
    })
    out.push(
      ...applyMediaOrder(
        mediaPoints.filter(
          (point) => (dayKeyByPoint.get(point) ?? null) === null,
        ),
        order[UNDATED_DAY_KEY],
      ),
    )
    return out
  }, [mediaPoints, points, dayPlan, slideshowSettings])

  // Médias en 2 temps (consultation) : une fois le voile levé, préchargement
  // en fond des photos/360 (variante d'affichage, pas l'original brut) dans
  // l'ordre de lecture → lightbox et diaporama instantanés. Petit délai pour
  // laisser les dernières tuiles finir ; jamais en Studio ni avant l'affichage ;
  // vidéos exclues (lourdes).
  useEffect(() => {
    if (!mapReady || isStudioMode) return
    let stopPrefetch: (() => void) | null = null
    const timer = window.setTimeout(() => {
      const items: MediaPrefetchItem[] = []
      for (const point of orderedMediaPoints) {
        const media = resolvePointMedia(point, mediaLibrary)
        if (!media || media.kind !== 'image') continue
        items.push({
          src: media.displaySrc ?? media.src,
          kind: point.type === '360' ? '360' : 'image',
        })
      }
      if (items.length > 0) stopPrefetch = startMediaPrefetch(items)
    }, 1500)
    return () => {
      window.clearTimeout(timer)
      stopPrefetch?.()
    }
  }, [mapReady, isStudioMode, orderedMediaPoints, mediaLibrary])

  // Autosave discrète : on garde un instantané à jour de tout ce qui part dans
  // le projet pour pouvoir publier en arrière-plan après un import, sans
  // dépendre des closures des handlers.
  const autosaveTimerRef = useRef<number | null>(null)
  // Géocodage inverse en tâche de fond (Studio) : ids déjà tentés (pour ne pas
  // reboucler sur un échec). Les points les plus récents sont lus via
  // latestProjectRef (mis à jour dans un effet plus bas).
  const geocodeAttemptedRef = useRef<Set<string>>(new Set())
  // Rattrapage de la variante d'affichage (Studio) : mêmes règles que le
  // géocodeur ci-dessus (ids déjà tentés, lecture via latestProjectRef).
  const displayBackfillAttemptedRef = useRef<Set<string>>(new Set())
  const latestProjectRef = useRef({
    points,
    traces,
    mediaLibrary,
    accessCode,
    accessMode,
    pointsSourceName,
    adminPassword,
    stats,
    hikeTitle,
    isPublished,
    slideshow: slideshowSettings,
    mapConfig,
    signature: currentProjectSignature,
  })
  useEffect(() => {
    latestProjectRef.current = {
      points,
      traces,
      mediaLibrary,
      accessCode,
      accessMode,
      pointsSourceName,
      adminPassword,
      stats,
      hikeTitle,
      isPublished,
      slideshow: slideshowSettings,
      mapConfig,
      signature: currentProjectSignature,
    }
  }, [
    accessCode,
    accessMode,
    adminPassword,
    currentProjectSignature,
    hikeTitle,
    isPublished,
    mapConfig,
    mediaLibrary,
    points,
    pointsSourceName,
    slideshowSettings,
    stats,
    traces,
  ])

  const saveProjectSilently = useCallback(async () => {
    const snapshot = latestProjectRef.current

    try {
      const headers = await saveAuthHeaders(snapshot.adminPassword)
      if (!headers) return
      setIsAutosaving(true)
      setSaveStatus('Sauvegarde automatique…')

      // Même régime que la sauvegarde manuelle : les points des traces vivent
      // dans des fichiers R2 (project.json léger, limite Vercel ~4,5 Mo). Les
      // traces encore inline sont envoyées ici (dédupliquées par empreinte).
      const idToken = (await getIdToken()) ?? undefined
      let persistedTraces = snapshot.traces
      if (snapshot.traces.some((trace) => !trace.fileUrl)) {
        persistedTraces = await Promise.all(
          snapshot.traces.map(async (trace) => {
            if (trace.fileUrl) return trace
            const blob = serializeTracePoints(trace.points)
            const fingerprint = await traceBlobFingerprint(blob)
            const uploaded = await uploadMedia({
              file: blob,
              fingerprint,
              adminPassword: snapshot.adminPassword,
              idToken,
              trailCode: mapSlug,
              kind: 'trace',
            })
            return { ...trace, fileUrl: uploaded.url }
          }),
        )
        setTraces(persistedTraces)
      }

      const project: TrailProject = {
        // `track` présent pour la validation API, mais vide (points en R2).
        track: [],
        traces: tracesForStorage(persistedTraces),
        accessCode: snapshot.accessCode.trim() || undefined,
        slideshow: snapshot.slideshow,
        mapConfig: cleanMapConfig(snapshot.mapConfig),
        points: exportablePoints(snapshot.points),
        mediaLibrary: snapshot.mediaLibrary,
        trackSourceName:
          persistedTraces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName: snapshot.pointsSourceName,
        savedAt: new Date().toISOString(),
      }
      const response = await fetch('/api/project', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...project,
          // Identité de la carte = le slug (jamais le code d'accès secret).
          slug: mapSlug,
          // Visibilité courante (public = pas de code, private = code).
          accessMode: snapshot.accessMode,
          ...buildIndexMeta({
            title: snapshot.hikeTitle,
            code: mapSlug,
            distanceMeters: snapshot.stats.distanceMeters,
            elevationGainMeters: snapshot.stats.elevationGainMeters,
            pointCount: snapshot.points.length,
            mediaCount: snapshot.mediaLibrary.length,
            // L'autosave conserve le statut courant : un brouillon reste un
            // brouillon, une carte publiée reste publiée.
            status: snapshot.isPublished ? 'published' : 'draft',
          }),
        }),
      })

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          message?: string
        } | null
        throw new Error(result?.message ?? 'Sauvegarde auto impossible.')
      }
      // Signature recalculée sur les traces PERSISTÉES (avec fileUrl), sinon
      // « modifications non sauvegardées » resterait à vrai après l'autosave.
      setSavedProjectSignature(
        projectSignature({
          points: snapshot.points,
          traces: persistedTraces,
          mediaLibrary: snapshot.mediaLibrary,
          accessCode: snapshot.accessCode,
          pointsSourceName: snapshot.pointsSourceName,
          slideshow: snapshot.slideshow,
          mapConfig: snapshot.mapConfig,
        }),
      )
      syncStudioUrlToCode(mapSlug)
      setSaveStatus('Modifs sauvegardées automatiquement.')
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? friendlyStorageMessage(saveError.message)
          : 'Sauvegarde auto impossible.'
      setSaveStatus(
        `Sauvegarde R2 impossible : ${message}`,
      )
    } finally {
      setIsAutosaving(false)
    }
  }, [mapSlug])

  // Publie en arrière-plan ~1,5 s après le dernier import (debounce), pour ne
  // plus perdre des médias déjà envoyés si la page se recharge.
  const scheduleAutosave = useCallback(() => {
    // Avec Firebase, l'auth vient du jeton (résolu dans saveProjectSilently).
    if (!firebaseEnabled && !latestProjectRef.current.adminPassword) return
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      void saveProjectSilently()
    }, 1500)
  }, [saveProjectSilently])

  useEffect(
    () => () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current)
      }
    },
    [],
  )

  // Géocodeur de fond (Studio) : géocode UN point média géolocalisé à la fois
  // (throttle léger), stocke le lieu dans `placeName`, et déclenche l'autosave.
  // Best-effort : un échec est mémorisé (pas de reboucle).
  useEffect(() => {
    if (!isStudioMode) return
    let cancelled = false
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms))
    const isMediaPoint = (point: TrailPoint) =>
      point.type === 'photo' ||
      point.type === 'video' ||
      point.type === '360' ||
      Boolean(point.image || point.video || point.skypixelUrl)
    const run = async () => {
      while (!cancelled) {
        const next = latestProjectRef.current.points.find(
          (point) =>
            point.id &&
            !point.placeName &&
            isMediaPoint(point) &&
            Number.isFinite(point.lat) &&
            Number.isFinite(point.lng) &&
            !geocodeAttemptedRef.current.has(point.id),
        )
        if (!next?.id) {
          await sleep(3000) // rien à faire ; on re-scrute (nouveaux imports)
          continue
        }
        geocodeAttemptedRef.current.add(next.id)
        const place = await reverseGeocode(next.lat, next.lng)
        if (cancelled) return
        if (place) {
          setPoints((current) =>
            current.map((point) =>
              point.id === next.id ? { ...point, placeName: place } : point,
            ),
          )
          scheduleAutosave()
        }
        await sleep(600) // throttle poli entre deux requêtes
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [isStudioMode, scheduleAutosave])

  // Rattrapage de la variante d'affichage (Studio) : les cartes créées avant
  // ce chantier (2026-07-20) n'ont que l'original + la vignette. En tâche de
  // fond, UN média à la fois (throttle léger, comme le géocodeur ci-dessus) :
  // retélécharge l'original depuis le videur (déjà autorisé, ticket posé),
  // génère la variante dans le navigateur, l'envoie sur R2, persiste
  // `displayUrl` et déclenche l'autosave. Best-effort : un échec (réseau,
  // format) est mémorisé pour ne pas reboucler dessus indéfiniment ; la carte
  // reste utilisable avec l'original en attendant (fallback `?? media.src`
  // partout où `displaySrc` est consommé).
  useEffect(() => {
    if (!isStudioMode) return
    let cancelled = false
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms))
    const run = async () => {
      while (!cancelled) {
        const next = latestProjectRef.current.mediaLibrary.find(
          (media) =>
            media.id &&
            media.kind === 'image' &&
            media.url &&
            !media.url.startsWith('blob:') &&
            !media.displayUrl &&
            !displayBackfillAttemptedRef.current.has(media.id),
        )
        if (!next) {
          await sleep(5000) // rien à faire ; re-scrute (nouveaux imports)
          continue
        }
        displayBackfillAttemptedRef.current.add(next.id)
        try {
          const response = await fetch(next.url, { credentials: 'include' })
          if (!response.ok) throw new Error('téléchargement impossible')
          const blob = await response.blob()
          const file = new File([blob], next.name || 'media.jpg', {
            type: next.mimeType || blob.type,
          })
          const display = await createDisplayVariant(file, 'image')
          if (display && !cancelled) {
            const fingerprint = await fileFingerprint(file)
            const idToken = (await getIdToken()) ?? undefined
            const uploaded = await uploadMedia({
              file: display,
              fingerprint,
              adminPassword: latestProjectRef.current.adminPassword,
              idToken,
              trailCode: mapSlug,
              kind: 'display',
            })
            if (!cancelled) {
              setMediaLibrary((current) =>
                current.map((item) =>
                  item.id === next.id
                    ? { ...item, displayUrl: uploaded.url }
                    : item,
                ),
              )
              scheduleAutosave()
            }
          }
        } catch {
          // Best-effort : on retentera au prochain chargement du Studio
          // (le ref n'est pas persisté), pas dans cette même session.
        }
        await sleep(800) // throttle poli entre deux médias
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [isStudioMode, scheduleAutosave, mapSlug])

  const handleSelectPoint = useCallback((point: TrailPoint) => {
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  const handleClosePoint = useCallback(() => {
    setSelectedPoint(null)
  }, [])

  const handleOpenLightbox = useCallback((media: LightboxMedia) => {
    setLightbox({ items: [media], index: 0 })
  }, [])

  const handleCloseLightbox = useCallback(() => {
    setLightbox(null)
  }, [])

  // Clic sur un marqueur : photo/vidéo en grand, sinon ouverture de la fiche.
  const handleMarkerClick = useCallback(
    (point: TrailPoint) => {
      const media = resolvePointMedia(point, mediaLibrary)
      if (media && (media.kind === 'image' || media.kind === 'video')) {
        // Image d'un point 360 : viewer panoramique au lieu de l'image plate.
        const kind =
          point.type === '360' && media.kind === 'image' ? '360' : media.kind
        const takenAt = findPointMediaItem(point, mediaLibrary)?.takenAt
        setLightbox({
          items: [
            {
              src: media.src,
              kind,
              title: point.title,
              ...(takenAt ? { takenAt } : {}),
              ...(point.placeName ? { placeName: point.placeName } : {}),
            },
          ],
          index: 0,
        })
        return
      }
      handleSelectPoint(point)
    },
    [handleSelectPoint, mediaLibrary],
  )

  // Clic sur un groupe de vignettes : galerie des photos/vidéos du groupe.
  const handleOpenGroup = useCallback(
    (groupPoints: TrailPoint[]) => {
      const items = pointsToLightboxItems(groupPoints, mediaLibrary)
      if (items.length > 0) setLightbox({ items, index: 0 })
    },
    [mediaLibrary],
  )

  // Aperçu d'un média depuis l'éditeur de diaporama : ouvre la lightbox sur ce
  // média (navigable parmi tous, dans l'ordre affiché) pour savoir ce que c'est.
  const handlePreviewEditorMedia = useCallback(
    (point: TrailPoint) => {
      const previewable = orderedMediaPoints.filter((candidate) => {
        const media = resolvePointMedia(candidate, mediaLibrary)
        return Boolean(media) && (media?.kind === 'image' || media?.kind === 'video')
      })
      const items = pointsToLightboxItems(previewable, mediaLibrary)
      if (items.length === 0) return
      const index = Math.max(0, previewable.indexOf(point))
      setLightbox({ items, index })
    },
    [orderedMediaPoints, mediaLibrary],
  )

  // Diaporama. Carte d'un seul jour : tous les médias dans l'ordre du parcours
  // (comportement historique). Voyage multi-jours : diaporama NARRATIF, dans
  // l'ordre chronologique par jour, avec une carte de transition avant chaque
  // journée (« Jour N », date, distance, D+, médias) pour raconter l'avancée.
  // Les réglages du Studio (slideshowSettings) personnalisent titres/intros
  // des jours, durées, médias masqués et carte de fin.
  const slideshowItems = useMemo<LightboxMedia[]>(() => {
    const mediaSettings = slideshowSettings?.media
    const daySettings = slideshowSettings?.days
    const orderSettings = slideshowSettings?.order
    const shownMediaPoints = mediaPoints.filter(
      (point) => !(point.id && mediaSettings?.[point.id]?.excluded),
    )
    const items: LightboxMedia[] = []

    if (!dayPlan.multiDay) {
      items.push(
        ...pointsToLightboxItems(
          applyMediaOrder(shownMediaPoints, orderSettings?.[ALL_MEDIA_ORDER_KEY]),
          mediaLibrary,
          mediaSettings,
        ),
      )
    } else {
      const dayKeyByPoint = new Map<TrailPoint, string | null>()
      points.forEach((point, index) => {
        dayKeyByPoint.set(point, dayPlan.pointDayKeys[index] ?? null)
      })
      dayPlan.days.forEach((day, dayIndex) => {
        const dayStats = computeDayStats(day, traces)
        // Médias du jour en ordre chronologique (porté par mediaPoints), sauf
        // ordre custom du Studio pour cette journée.
        const dayMedia = applyMediaOrder(
          shownMediaPoints.filter(
            (point) => dayKeyByPoint.get(point) === day.key,
          ),
          orderSettings?.[day.key],
        )
        const custom = daySettings?.[day.key]
        const dayLabel = custom?.title?.trim() || day.label
        items.push({
          src: `day-break-${day.key}`,
          kind: 'day-break',
          title: dayLabel,
          dayBreak: {
            label: dayLabel,
            dateLabel: day.dateLabel,
            color: day.color,
            intro: custom?.intro?.trim() || defaultDayIntro(dayIndex),
            distanceLabel:
              dayStats.distanceMeters > 0
                ? formatDistance(dayStats.distanceMeters)
                : undefined,
            gainLabel:
              dayStats.elevationGainMeters > 0
                ? formatGain(dayStats.elevationGainMeters)
                : undefined,
            mediaCount: dayMedia.length,
          },
        })
        items.push(...pointsToLightboxItems(dayMedia, mediaLibrary, mediaSettings))
      })
      // Médias non datés en fin de récit, sous leur propre carte.
      const undatedMedia = applyMediaOrder(
        shownMediaPoints.filter(
          (point) => (dayKeyByPoint.get(point) ?? null) === null,
        ),
        orderSettings?.[UNDATED_DAY_KEY],
      )
      if (undatedMedia.length > 0) {
        const custom = daySettings?.[UNDATED_DAY_KEY]
        const undatedLabel = custom?.title?.trim() || UNDATED_DEFAULT_LABEL
        items.push({
          src: 'day-break-undated',
          kind: 'day-break',
          title: undatedLabel,
          dayBreak: {
            label: undatedLabel,
            dateLabel: 'Sans date',
            color: '#93a1b5',
            intro: custom?.intro?.trim() || UNDATED_DEFAULT_INTRO,
            mediaCount: undatedMedia.length,
          },
        })
        items.push(
          ...pointsToLightboxItems(undatedMedia, mediaLibrary, mediaSettings),
        )
      }
    }

    // Carte de fin (stats totales du voyage) : activée par défaut pour les
    // voyages multi-jours, sur demande pour les cartes d'un seul jour.
    const endCard = slideshowSettings?.endCard
    const endEnabled = endCard?.enabled ?? dayPlan.multiDay
    if (endEnabled && items.length > 0) {
      const endLabel = endCard?.title?.trim() || END_CARD_DEFAULT_TITLE
      items.push({
        src: 'day-break-end',
        kind: 'day-break',
        title: endLabel,
        dayBreak: {
          label: endLabel,
          dateLabel: hikeTitle.trim(),
          color: '#4fd1a1',
          intro: END_CARD_DEFAULT_INTRO,
          distanceLabel:
            stats.distanceMeters > 0
              ? formatDistance(stats.distanceMeters)
              : undefined,
          gainLabel:
            stats.elevationGainMeters > 0
              ? formatGain(stats.elevationGainMeters)
              : undefined,
          mediaCount: shownMediaPoints.length,
        },
      })
    }
    return items
  }, [
    dayPlan,
    mediaPoints,
    points,
    mediaLibrary,
    traces,
    slideshowSettings,
    stats,
    hikeTitle,
  ])
  const handleOpenSlideshow = useCallback(() => {
    if (slideshowItems.length === 0) return
    const key = slideshowResumeKey(mapSlug)
    let start = 0
    // Reprise : on relit la dernière position si on a quitté il y a moins de 10 min.
    if (key) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw) {
          const saved = JSON.parse(raw) as { index?: number; ts?: number }
          if (
            typeof saved.index === 'number' &&
            typeof saved.ts === 'number' &&
            Date.now() - saved.ts <= SLIDESHOW_RESUME_MS &&
            saved.index > 0 &&
            saved.index < slideshowItems.length
          ) {
            start = saved.index
          } else {
            window.localStorage.removeItem(key)
          }
        }
      } catch {
        /* localStorage indisponible : on démarre au début */
      }
    }
    setLightbox({
      items: slideshowItems,
      index: start,
      persistKey: key || undefined,
    })
  }, [slideshowItems, mapSlug])

  // Réglages du diaporama (éditeur du Studio) : chaque modif marque le projet
  // « non sauvegardé » (signature) et programme une autosave discrète.
  const handleSlideshowSettingsChange = useCallback(
    (next: SlideshowSettings | undefined) => {
      setSlideshowSettings(next)
      scheduleAutosave()
    },
    [scheduleAutosave],
  )

  // Prévisualisation depuis l'éditeur : le vrai diaporama, du début, sans
  // toucher à la position de reprise mémorisée.
  const handlePreviewSlideshow = useCallback(() => {
    if (slideshowItems.length === 0) return
    setLightbox({ items: slideshowItems, index: 0 })
  }, [slideshowItems])

  const handleAdminPasswordChange = useCallback((password: string) => {
    setAdminPassword(password)
    setSaveStatus(null)
  }, [])

  const handleBasemapChange = useCallback((nextBasemap: BasemapId) => {
    setBasemap(nextBasemap)
  }, [])

  // Réglages de la carte (Studio) : mode de vue et fond par défaut, persistés
  // dans mapConfig (autosave). Changer le fond par défaut bascule aussi la vue
  // courante pour un retour visuel immédiat.
  const handleViewModeChange = useCallback(
    (mode: MapViewMode) => {
      setMapConfig((current) => ({ ...current, viewMode: mode }))
      scheduleAutosave()
    },
    [scheduleAutosave],
  )
  const handleDefaultBasemapChange = useCallback(
    (id: BasemapId) => {
      setMapConfig((current) => ({ ...current, defaultBasemap: id }))
      setBasemap(id)
      scheduleAutosave()
    },
    [scheduleAutosave],
  )

  // Conserve le cycle existant : Auto → 2D → 3D → Auto.
  const handleCyclePerfMode = useCallback(() => {
    setPerfMode((current) => {
      const next: PerfMode =
        current === 'auto'
          ? 'force-2d'
          : current === 'force-2d'
            ? 'force-3d'
            : 'auto'
      return next
    })
  }, [])

  const handleRecenter = useCallback(() => {
    setRecenterRequest((current) => current + 1)
  }, [])

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        window.location.origin + publicUrl(mapSlug),
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copie du lien impossible.')
    }
  }, [mapSlug])

  const handleOpenConsultation = useCallback(() => {
    openConsultationFromStudio(mapSlug)
  }, [mapSlug])

  const openDashboard = useCallback(() => {
    window.location.assign('/dashboard')
  }, [])

  const handleOpenDashboard = useCallback(() => {
    if (hasUnsavedProjectChanges || hasPanelDraft) {
      setShowDashboardConfirm(true)
      return
    }
    openDashboard()
  }, [hasPanelDraft, hasUnsavedProjectChanges, openDashboard])

  const sendCameraCommand = useCallback((type: CameraCommand['type']) => {
    setCameraCommand({ id: Date.now(), type })
  }, [])

  // Import additif : chaque GPX devient une trace distincte. Les points partent
  // dans un fichier R2 dédié (comme un média) : project.json reste léger quel
  // que soit le volume, et la trace garde sa fidélité brute (zéro simplification).
  const handleImportGpx = useCallback(
    async (files: File[]) => {
      if (!firebaseEnabled && !adminPassword) {
        setError('Saisis le mot de passe Studio avant un import GPX.')
        return
      }
      if (!mapSlug) {
        setError('Identifiant de carte manquant : rouvre-la depuis le tableau de bord.')
        return
      }

      const idToken = (await getIdToken()) ?? undefined
      const newTraces: Trace[] = []
      let failures = 0
      let index = 0

      for (const file of files) {
        index += 1
        try {
          const parsedTrack = parseGpx(await file.text())
          if (parsedTrack.length < 2) {
            failures += 1
            continue
          }
          setSaveStatus(`Envoi des traces... (${index}/${files.length})`)
          const blob = serializeTracePoints(parsedTrack)
          const fingerprint = await traceBlobFingerprint(blob)
          const uploaded = await uploadMedia({
            file: blob,
            fingerprint,
            adminPassword,
            idToken,
            trailCode: mapSlug,
            kind: 'trace',
          })
          newTraces.push({
            id: createTraceId(),
            name: file.name.replace(/\.gpx$/i, ''),
            points: parsedTrack,
            fileUrl: uploaded.url,
          })
        } catch {
          failures += 1
        }
      }

      if (newTraces.length === 0) {
        setSaveStatus('Import GPX impossible.')
        setError('Aucune trace GPX valide dans la sélection (ou envoi refusé).')
        return
      }

      setTraces((current) => [...current, ...newTraces])
      setSelectedPoint(null)
      setSaveStatus(`${newTraces.length} trace(s) GPX importée(s).`)
      setError(failures > 0 ? `${failures} fichier(s) GPX ignoré(s).` : null)
    },
    [adminPassword, mapSlug],
  )

  const handleDeleteTrace = useCallback((traceId: string) => {
    setTraces((current) => current.filter((trace) => trace.id !== traceId))
  }, [])

  const handleReorderTrace = useCallback(
    (draggedTraceId: string, targetTraceId: string) => {
      if (draggedTraceId === targetTraceId) return

      setTraces((current) => {
        const fromIndex = current.findIndex(
          (trace) => trace.id === draggedTraceId,
        )
        const toIndex = current.findIndex((trace) => trace.id === targetTraceId)

        if (fromIndex < 0 || toIndex < 0) return current

        const next = [...current]
        const [movedTrace] = next.splice(fromIndex, 1)
        if (!movedTrace) return current
        next.splice(toIndex, 0, movedTrace)
        return next
      })
    },
    [],
  )

  const handleRenameTrace = useCallback((traceId: string, name: string) => {
    setTraces((current) =>
      current.map((trace) =>
        trace.id === traceId ? { ...trace, name } : trace,
      ),
    )
  }, [])

  const handleSetTraceColor = useCallback((traceId: string, color: string) => {
    setTraces((current) =>
      current.map((trace) =>
        trace.id === traceId ? { ...trace, color } : trace,
      ),
    )
  }, [])

  const handleAccessCodeChange = useCallback((code: string) => {
    setAccessCode(code)
  }, [])

  const handleAccessModeChange = useCallback((mode: 'public' | 'private') => {
    setAccessMode(mode)
  }, [])

  // Charge le contenu complet d'une carte protégée une fois le ticket obtenu
  // (le cookie de grant est déjà posé). Renvoie true si le contenu est bien venu.
  const loadProtectedContent = useCallback(async (): Promise<boolean> => {
    if (!mapSlug) return false
    try {
      const res = await fetch(`/api/project?m=${encodeURIComponent(mapSlug)}`, {
        cache: 'no-store',
        credentials: 'include',
      })
      if (!res.ok) return false
      const raw = (await res.json()) as Partial<TrailProject> & {
        hikeStatus?: string
        protected?: boolean
      }
      if (raw.protected === true && !Array.isArray(raw.points)) return false
      const project = normalizeProject(raw)
      if (!project) return false
      setIsPublished(raw.hikeStatus !== 'draft')
      // Le cookie ticket est posé (code validé) : on peut hydrater les traces R2.
      const hydrated = await hydrateProjectTraces(project)
      applyProject(hydrated.project)
      return true
    } catch {
      return false
    }
  }, [applyProject, mapSlug])

  // Saisie du code par le VISITEUR : le serveur le valide (via /api/media-ticket)
  // et ne pose le cookie de grant qu'en cas de succès. On charge alors le contenu.
  const handleGrantAccess = useCallback(
    async (code: string): Promise<boolean> => {
      const trimmed = code.trim()
      if (!trimmed || !mapSlug) return false
      const refreshInMs = await requestMediaTicket({
        code: mapSlug,
        accessCode: trimmed,
      })
      if (refreshInMs === null) return false // code incorrect (401) ou erreur
      visitorCodeRef.current = trimmed
      const ok = await loadProtectedContent()
      if (ok) setAccessGranted(true)
      return ok
    },
    [mapSlug, loadProtectedContent],
  )

  const handleImportMedia = useCallback(async (files: File[]) => {
    if (!firebaseEnabled && !adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio avant un import media.')
      return
    }
    if (!mapSlug) {
      setSaveStatus('Enregistre la carte avant un import média.')
      return
    }

    const mediaFiles = files.filter((file) => mediaKindFromFile(file) !== null)
    if (mediaFiles.length === 0) {
      setSaveStatus('Aucune photo ou vidéo reconnue dans la sélection.')
      return
    }

    const knownFingerprints = new Set(
      mediaLibrary
        .map((media) => media.fingerprint)
        .filter((value): value is string => Boolean(value)),
    )
    const selectedFingerprints = new Set<string>()
    const duplicates: ImportReport['duplicates'] = []
    const uploadEntries: Array<{ file: File; fingerprint: string }> = []

    setSaveStatus('Analyse des doublons...')
    for (const file of mediaFiles) {
      const fingerprints = await fileFingerprints(file)
      const alreadyImported = fingerprints.all.some((fingerprint) =>
        knownFingerprints.has(fingerprint),
      )
      const alreadySelected = fingerprints.all.some((fingerprint) =>
        selectedFingerprints.has(fingerprint),
      )
      if (alreadyImported || alreadySelected) {
        duplicates.push({
          name: file.name,
          detail: alreadyImported
            ? 'deja dans la bibliotheque'
            : 'doublon de la selection',
        })
      } else {
        fingerprints.all.forEach((fingerprint) =>
          selectedFingerprints.add(fingerprint),
        )
        uploadEntries.push({ file, fingerprint: fingerprints.primary })
      }
    }

    if (uploadEntries.length === 0) {
      setImportReport({
        total: mediaFiles.length,
        placed: [],
        noGps: [],
        offTrack: [],
        duplicates,
        failed: [],
      })
      setSaveStatus('Tous les fichiers selectionnes sont deja presents.')
      return
    }

    setIsUploading(true)
    setImportReport(null)
    setSaveStatus(`Envoi de ${uploadEntries.length} media(s) vers le stockage...`)

    // Jeton Firebase (si connecté) pour authentifier les uploads.
    const idToken = (await getIdToken()) ?? undefined

    // Progression globale basée sur les octets, robuste à la concurrence.
    const totalBytes = uploadEntries.reduce(
      (sum, entry) => sum + entry.file.size,
      0,
    ) || 1
    const loadedByIndex = new Array<number>(uploadEntries.length).fill(0)
    let completedCount = 0

    const refreshProgress = (currentName: string) => {
      const loaded = loadedByIndex.reduce((sum, value) => sum + value, 0)
      setUploadProgress({
        fileIndex: Math.min(completedCount + 1, uploadEntries.length),
        fileCount: uploadEntries.length,
        fileName: currentName,
        percentage: Math.min(Math.round((loaded / totalBytes) * 100), 100),
      })
    }

    const results = new Array<ImportedMedia | null>(uploadEntries.length).fill(null)
    const failed: ImportReport['failed'] = []
    let cursor = 0

    // Un fichier en échec n'interrompt plus le lot : on consigne et on continue.
    const worker = async () => {
      while (cursor < uploadEntries.length) {
        const index = cursor
        cursor += 1
        const { file, fingerprint } = uploadEntries[index]
        refreshProgress(file.name)

        let media: ImportedMedia | null = null
        try {
          media = await createImportedMedia(file)
          if (!media) {
            failed.push({ name: file.name, detail: 'format non reconnu' })
            continue
          }

          const uploaded = await uploadMedia({
            file,
            fingerprint,
            adminPassword,
            idToken,
            trailCode: mapSlug,
            onProgress: (loaded) => {
              loadedByIndex[index] = loaded
              refreshProgress(file.name)
            },
          })

          const preview = await createMediaPreview(file, media.kind)
          const previewUpload = preview
            ? await uploadMedia({
                file: preview,
                fingerprint,
                adminPassword,
                idToken,
                trailCode: mapSlug,
                kind: 'preview',
              }).catch(() => null)
            : null

          // Variante d'affichage (~2000 px) : photos uniquement, cf.
          // mediaPreview.ts. Best-effort — un échec laisse `displayUrl` absent,
          // les appelants retombent alors sur l'original.
          const display = await createDisplayVariant(file, media.kind)
          const displayUpload = display
            ? await uploadMedia({
                file: display,
                fingerprint,
                adminPassword,
                idToken,
                trailCode: mapSlug,
                kind: 'display',
              }).catch(() => null)
            : null

          results[index] = {
            ...media,
            fingerprint,
            url: uploaded.url,
            ...(previewUpload ? { thumbnailUrl: previewUpload.url } : {}),
            ...(displayUpload ? { displayUrl: displayUpload.url } : {}),
          }
        } catch (uploadError) {
          failed.push({
            name: file.name,
            detail:
              uploadError instanceof Error
                ? uploadError.message
                : 'envoi impossible',
          })
        } finally {
          if (media) URL.revokeObjectURL(media.url)
          loadedByIndex[index] = file.size
          completedCount += 1
          refreshProgress(file.name)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(uploadConcurrency, uploadEntries.length) }, () =>
        worker(),
      ),
    )

    setIsUploading(false)
    setUploadProgress(null)

    const importedMedia = results.filter(
      (media): media is ImportedMedia => media !== null,
    )

    // Classement vs tracé : sans GPS / position aberrante / placé.
    const threshold = offTrackThresholdMeters(combinedPoints)
    const noGps: ImportReport['noGps'] = []
    const offTrack: ImportReport['offTrack'] = []
    const placed: ImportReport['placed'] = []
    const placedMedia: ImportedMedia[] = []

    for (const media of importedMedia) {
      if (media.lat === undefined || media.lng === undefined) {
        noGps.push({ name: media.name, mediaId: media.id })
        continue
      }
      const distance = distanceToTrack(
        { lat: media.lat, lng: media.lng },
        combinedPoints,
      )
      if (distance > threshold) {
        offTrack.push({
          name: media.name,
          mediaId: media.id,
          detail: `à ${formatKilometers(distance)} du tracé`,
        })
        continue
      }
      placed.push({ name: media.name })
      placedMedia.push(media)
    }

    if (importedMedia.length > 0) {
      setMediaLibrary((current) => {
        const newMedia = importedMedia.filter(
          (media) => !mediaAlreadyInLibrary(current, media),
        )
        return [...current, ...newMedia]
      })
    }

    if (placedMedia.length > 0) {
      const existingMediaNames = new Set(
        points
          .map((point) => point.mediaName?.toLowerCase())
          .filter((name): name is string => Boolean(name)),
      )
      const autoPoints = placedMedia
        .filter((media) => !existingMediaNames.has(media.name.toLowerCase()))
        .map<TrailPoint>((media) => ({
          id: `media-${media.id}`,
          lat: media.lat as number,
          lng: media.lng as number,
          title: media.name.replace(/\.[^.]+$/, ''),
          type: media.kind === 'video' ? 'video' : 'photo',
          mediaName: media.name,
          mediaKind: media.kind,
          ...(media.kind === 'video' ? { video: media.url } : { image: media.url }),
        }))

      if (autoPoints.length > 0) {
        setPoints((current) => [...current, ...autoPoints])
      }
    }

    // Import direct, sans validation point par point : le rapport résume tout.
    setSelectedPoint(null)

    setImportReport({
      total: mediaFiles.length,
      placed,
      noGps,
      offTrack,
      duplicates,
      failed,
    })

    setError(null)
    setSaveStatus(
      failed.length > 0
        ? `${importedMedia.length}/${mediaFiles.length} média(s) envoyé(s). Voir le rapport.`
        : 'Medias envoyes. Publie la carte pour partager les points.',
    )
    if (importedMedia.length > 0) scheduleAutosave()
  }, [mapSlug, adminPassword, points, combinedPoints, mediaLibrary, scheduleAutosave])

  const handleImportDriveMedia = useCallback(async () => {
    if (!isGoogleDriveConfigured) {
      setSaveStatus(
        'Configure Google Drive dans Vercel avant d’utiliser cet import.',
      )
      return
    }
    if (!firebaseEnabled && !adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio avant un import média.')
      return
    }
    if (!mapSlug) {
      setSaveStatus('Renseigne le code de la carte avant un import média.')
      return
    }

    setIsDriveImporting(true)
    setSaveStatus('Ouverture de Google Drive...')
    try {
      const files = await pickGoogleDriveMedia()
      if (files.length === 0) {
        setSaveStatus('Aucun média Google Drive sélectionné.')
        return
      }
      await handleImportMedia(files)
    } catch (driveError) {
      setSaveStatus(
        driveError instanceof Error
          ? driveError.message
          : 'Import Google Drive impossible.',
      )
    } finally {
      setIsDriveImporting(false)
    }
  }, [mapSlug, adminPassword, handleImportMedia, isGoogleDriveConfigured])

  const handleDismissReport = useCallback(() => {
    setImportReport(null)
  }, [])

  const removeMediaLocally = useCallback(
    (
      removedMedia: ImportedMedia[],
      options: { detachPoints: boolean },
    ): void => {
      if (removedMedia.length === 0) return
      const removedIds = new Set(removedMedia.map((media) => media.id))

      setMediaLibrary((current) =>
        current.filter((media) => !removedIds.has(media.id)),
      )
      setManualPlacementMediaId((current) =>
        current && removedIds.has(current) ? null : current,
      )
      setImportReport((current) =>
        pruneMediaFromImportReport(current, removedMedia),
      )

      if (!options.detachPoints) return

      const detach = (point: TrailPoint): TrailPoint =>
        removedMedia.reduce(stripMediaFromPoint, point)
      setPoints((current) => current.map(detach))
      setSelectedPoint((current) => (current ? detach(current) : current))
    },
    [],
  )

  const deleteStoredMedia = useCallback(
    async (media: ImportedMedia): Promise<void> => {
      if (!mapSlug) {
        throw new Error('Renseigne le code de la carte avant la suppression.')
      }
      const idToken = (await getIdToken()) ?? undefined
      if (!idToken && !adminPassword) {
        throw new Error('Connecte-toi ou saisis le mot de passe Studio.')
      }
      await deleteUploadedMedia({
        mediaUrl: media.url,
        thumbnailUrl: media.thumbnailUrl,
        adminPassword,
        idToken,
        trailCode: mapSlug,
      })
    },
    [mapSlug, adminPassword],
  )

  const handleDeleteMedia = useCallback(
    async (mediaId: string) => {
      const media = mediaLibrary.find((item) => item.id === mediaId)
      if (!media) {
        setSaveStatus('Média introuvable dans la bibliothèque.')
        return
      }

      setDeletingMediaId(mediaId)
      setSaveStatus(`Suppression de ${media.name}...`)
      try {
        await deleteStoredMedia(media)
        removeMediaLocally([media], { detachPoints: true })
        setSaveStatus(
          'Média supprimé du stockage. Les points liés sont conservés sans média.',
        )
        scheduleAutosave()
      } catch (deleteError) {
        const message =
          deleteError instanceof Error
            ? deleteError.message
            : 'suppression R2 impossible'
        setSaveStatus(`Suppression du média impossible : ${message}`)
      } finally {
        setDeletingMediaId(null)
      }
    },
    [deleteStoredMedia, mediaLibrary, removeMediaLocally, scheduleAutosave],
  )

  const handleCleanupUnusedMedia = useCallback(async () => {
    if (!firebaseEnabled && !adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio avant le nettoyage.')
      return
    }
    if (!mapSlug) {
      setSaveStatus('Renseigne le code de la carte avant le nettoyage.')
      return
    }

    setIsCleaningUnusedMedia(true)
    setSaveStatus('Recherche des fichiers R2 inutilisés...')
    try {
      const unusedMedia = mediaLibrary.filter(
        (media) => !points.some((point) => pointUsesMedia(point, media)),
      )
      const idToken = (await getIdToken()) ?? undefined
      const cleanup = await cleanupUnusedUploadedMedia({
        // Les fichiers de traces de la carte sont des fichiers UTILISÉS : sans
        // leurs URLs ici, le nettoyage les prendrait pour des orphelins.
        usedUrls: [
          ...usedMediaUrls,
          ...traces
            .map((trace) => trace.fileUrl)
            .filter((url): url is string => Boolean(url)),
        ],
        adminPassword,
        idToken,
        trailCode: mapSlug,
      })
      removeMediaLocally(unusedMedia, { detachPoints: false })
      const cleanupDetails = [
        cleanup.mediaDeletedCount
          ? `${cleanup.mediaDeletedCount} média(s)`
          : null,
        cleanup.previewDeletedCount
          ? `${cleanup.previewDeletedCount} aperçu(s)`
          : null,
      ]
        .filter(Boolean)
        .join(' + ')
      setSaveStatus(
        cleanup.deletedCount > 0
          ? `${cleanup.deletedCount} fichier(s) R2 inutilisé(s) supprimé(s)${
              cleanupDetails ? ` : ${cleanupDetails}.` : '.'
            }`
          : 'Aucun fichier inutilisé trouvé dans R2.',
      )
      if (unusedMedia.length > 0) scheduleAutosave()
    } catch (cleanupError) {
      setSaveStatus(
        cleanupError instanceof Error
          ? `Nettoyage R2 impossible : ${cleanupError.message}`
          : 'Nettoyage R2 impossible.',
      )
    } finally {
      setIsCleaningUnusedMedia(false)
    }
  }, [
    mapSlug,
    adminPassword,
    traces,
    mediaLibrary,
    points,
    removeMediaLocally,
    scheduleAutosave,
    usedMediaUrls,
  ])

  const findImportReportMedia = useCallback(
    (mediaId: string): ImportedMedia | undefined => {
      const directMedia = mediaLibrary.find((item) => item.id === mediaId)
      if (directMedia) return directMedia

      const reportEntry = [
        ...(importReport?.noGps ?? []),
        ...(importReport?.offTrack ?? []),
      ].find((entry) => entry.mediaId === mediaId)
      if (!reportEntry) return undefined

      return mediaLibrary.find(
        (item) => item.name.toLowerCase() === reportEntry.name.toLowerCase(),
      )
    },
    [importReport, mediaLibrary],
  )

  const repairImportReportMediaId = useCallback(
    (oldMediaId: string, media: ImportedMedia) => {
      if (oldMediaId === media.id) return
      setImportReport((current) =>
        current
          ? {
              ...current,
              noGps: current.noGps.map((entry) =>
                entry.mediaId === oldMediaId
                  ? { ...entry, mediaId: media.id }
                  : entry,
              ),
              offTrack: current.offTrack.map((entry) =>
                entry.mediaId === oldMediaId
                  ? { ...entry, mediaId: media.id }
                  : entry,
              ),
            }
          : current,
      )
    },
    [],
  )

  const handlePlaceImportedMedia = useCallback(
    (mediaId: string) => {
      const media = findImportReportMedia(mediaId)
      if (!media) {
        setSaveStatus('Média introuvable dans la bibliothèque.')
        return
      }
      repairImportReportMediaId(mediaId, media)
      setManualPlacementMediaId(media.id)
      setSelectedPoint(null)
      setIsPanelOpen(false)
      setSaveStatus(
        `Clique sur la carte pour placer ${media.name}.`,
      )
    },
    [findImportReportMedia, repairImportReportMediaId],
  )

  const handleEstimateImportedMedia = useCallback(
    (mediaId: string) => {
      const media = findImportReportMedia(mediaId)
      if (!media) {
        setSaveStatus('Média introuvable dans la bibliothèque.')
        return
      }

      const updateNoGpsEntry = (
        patch: Partial<ImportReport['noGps'][number]>,
      ) => {
        setImportReport((current) =>
          current
            ? {
                ...current,
                noGps: current.noGps.map((entry) =>
                  entry.mediaId === mediaId ? { ...entry, ...patch } : entry,
                ),
              }
            : current,
        )
      }

      if (!media.takenAt) {
        updateNoGpsEntry({
          detail: 'Date EXIF introuvable',
          estimateUnavailable: true,
          placementEstimate: undefined,
        })
        return
      }

      const mediaTime = Date.parse(media.takenAt)
      if (!Number.isFinite(mediaTime) || timedTracePoints.length === 0) {
        updateNoGpsEntry({
          detail: 'Trace horodatée indisponible',
          estimateUnavailable: true,
          placementEstimate: undefined,
        })
        return
      }

      const nearest = timedTracePoints.reduce<{
        lat: number
        lng: number
        deltaMs: number
      } | null>((best, item) => {
        const deltaMs = Math.abs(item.timestamp - mediaTime)
        if (best && best.deltaMs <= deltaMs) return best
        return {
          lat: item.point.lat,
          lng: item.point.lng,
          deltaMs,
        }
      }, null)

      if (!nearest) {
        updateNoGpsEntry({
          detail: 'Trace horodatée indisponible',
          estimateUnavailable: true,
          placementEstimate: undefined,
        })
        return
      }

      const deltaMinutes = Math.round(nearest.deltaMs / 60_000)
      const detail =
        deltaMinutes <= 1
          ? 'Proposition proche de l’heure photo'
          : `Proposition à ${deltaMinutes} min de l’heure photo`
      updateNoGpsEntry({
        detail: undefined,
        estimateUnavailable: false,
        mediaId: media.id,
        placementEstimate: {
          lat: nearest.lat,
          lng: nearest.lng,
          detail,
        },
      })
    },
    [findImportReportMedia, timedTracePoints],
  )

  const handleIgnoreImportEntry = useCallback(
    async (
      section: 'noGps' | 'offTrack' | 'duplicates' | 'failed',
      entry: ImportReport['placed'][number],
    ) => {
      let ignoredMedia: ImportedMedia | undefined
      if (entry.mediaId) {
        ignoredMedia = mediaLibrary.find(
          (media) => media.id === entry.mediaId,
        )
        setMediaLibrary((current) =>
          current.filter((media) => media.id !== entry.mediaId),
        )
        if (ignoredMedia) {
          const mediaToIgnore = ignoredMedia
          setPoints((current) =>
            current.filter(
              (point) =>
                point.image !== mediaToIgnore.url &&
                point.video !== mediaToIgnore.url &&
                point.mediaName?.toLowerCase() !==
                  mediaToIgnore.name.toLowerCase(),
            ),
          )
          setSelectedPoint((current) =>
            current?.image === mediaToIgnore.url ||
            current?.video === mediaToIgnore.url ||
            current?.mediaName?.toLowerCase() === mediaToIgnore.name.toLowerCase()
              ? null
              : current,
          )
        }
        setManualPlacementMediaId((current) =>
          current === entry.mediaId ? null : current,
        )
      }

      setImportReport((current) => {
        if (!current) return current
        const next = {
          ...current,
          total: Math.max(current.total - 1, 0),
          [section]: current[section].filter((candidate) =>
            entry.mediaId
              ? candidate.mediaId !== entry.mediaId
              : candidate.name !== entry.name,
          ),
        }
        const remaining =
          next.placed.length +
          next.noGps.length +
          next.offTrack.length +
          next.duplicates.length +
          next.failed.length
        return remaining > 0 ? next : null
      })

      setSaveStatus('Fichier ignoré pour cette carte.')
      if (!ignoredMedia) {
        return
      }

      setSaveStatus('Fichier ignore. Suppression du stockage...')
      scheduleAutosave()

      try {
        const idToken = (await getIdToken()) ?? undefined
        await deleteUploadedMedia({
          mediaUrl: ignoredMedia.url,
          thumbnailUrl: ignoredMedia.thumbnailUrl,
          displayUrl: ignoredMedia.displayUrl,
          adminPassword,
          idToken,
          trailCode: mapSlug,
        })
        setSaveStatus('Fichier ignore et supprime du stockage.')
      } catch (deleteError) {
        const message =
          deleteError instanceof Error
            ? deleteError.message
            : 'suppression R2 impossible'
        setSaveStatus(`Fichier ignore, mais suppression R2 impossible : ${message}`)
      }
    },
    [mapSlug, adminPassword, mediaLibrary, scheduleAutosave],
  )

  // Import depuis la fiche d'un point : upload du fichier puis rattachement
  // immédiat comme média du point (photo du haut de la fiche).
  const handleAttachMedia = useCallback(
    async (pointId: string, file: File) => {
      if (!mapSlug) {
        setSaveStatus('Renseigne le code de la carte avant un import média.')
        return
      }
      if (mediaKindFromFile(file) === null) {
        setSaveStatus('Format non reconnu : photo ou vidéo attendue.')
        return
      }
      const idToken = (await getIdToken()) ?? undefined
      if (!idToken && !adminPassword) {
        setSaveStatus('Connecte-toi ou saisis le mot de passe Studio avant un import média.')
        return
      }

      setIsUploading(true)
      setSaveStatus(`Envoi de ${file.name}...`)
      let media: ImportedMedia | null = null
      try {
        media = await createImportedMedia(file)
        if (!media) {
          setSaveStatus('Format non reconnu : photo ou vidéo attendue.')
          return
        }
        const fingerprints = await fileFingerprints(file)
        const fingerprint = fingerprints.primary
        const existing = mediaLibrary.find(
          (item) =>
            Boolean(item.fingerprint && fingerprints.all.includes(item.fingerprint)),
        )
        const original = existing
          ? { url: existing.url }
          : await uploadMedia({
              file,
              fingerprint,
              adminPassword,
              idToken,
              trailCode: mapSlug,
            })
        const preview = existing?.thumbnailUrl
          ? null
          : await createMediaPreview(file, media.kind)
        const previewUpload = existing?.thumbnailUrl
          ? { url: existing.thumbnailUrl }
          : preview
            ? await uploadMedia({
                file: preview,
                fingerprint,
                adminPassword,
                idToken,
                trailCode: mapSlug,
                kind: 'preview',
              }).catch(() => null)
            : null
        const display = existing?.displayUrl
          ? null
          : await createDisplayVariant(file, media.kind)
        const displayUpload = existing?.displayUrl
          ? { url: existing.displayUrl }
          : display
            ? await uploadMedia({
                file: display,
                fingerprint,
                adminPassword,
                idToken,
                trailCode: mapSlug,
                kind: 'display',
              }).catch(() => null)
            : null
        const uploaded: ImportedMedia =
          existing
            ? {
                ...existing,
                fingerprint,
                ...(previewUpload ? { thumbnailUrl: previewUpload.url } : {}),
                ...(displayUpload ? { displayUrl: displayUpload.url } : {}),
              }
            : {
                ...media,
                fingerprint,
                url: original.url,
                ...(previewUpload ? { thumbnailUrl: previewUpload.url } : {}),
                ...(displayUpload ? { displayUrl: displayUpload.url } : {}),
              }

        setMediaLibrary((current) =>
          mediaAlreadyInLibrary(current, uploaded)
            ? current.map((item) =>
                item.id === uploaded.id ||
                item.url === uploaded.url ||
                Boolean(
                  uploaded.fingerprint &&
                    item.fingerprint === uploaded.fingerprint,
                )
                  ? uploaded
                  : item,
              )
            : [...current, uploaded],
        )

        const applyMedia = (point: TrailPoint): TrailPoint => ({
          ...point,
          mediaName: uploaded.name,
          mediaKind: uploaded.kind,
          image: uploaded.kind === 'image' ? uploaded.url : undefined,
          video: uploaded.kind === 'video' ? uploaded.url : undefined,
          type:
            uploaded.kind === 'video'
              ? 'video'
              : point.type === '360'
                ? '360'
                : 'photo',
        })

        setPoints((current) =>
          current.map((point) =>
            point.id === pointId ? applyMedia(point) : point,
          ),
        )
        setSelectedPoint((current) =>
          current?.id === pointId ? applyMedia(current) : current,
        )
        setError(null)
        setSaveStatus('Média attaché au point. Publie la carte pour partager.')
        scheduleAutosave()
      } catch (uploadError) {
        setSaveStatus(
          uploadError instanceof Error
            ? `Envoi impossible : ${uploadError.message}`
            : 'Envoi impossible.',
        )
      } finally {
        if (media) URL.revokeObjectURL(media.url)
        setIsUploading(false)
      }
    },
    [mapSlug, adminPassword, mediaLibrary, scheduleAutosave],
  )

  const handleAddPoint = useCallback((point: TrailPoint) => {
    setPoints((current) => [...current, point])
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  // Appui long sur la carte (Studio) : crée un point à éditer.
  const placeImportedMediaAt = useCallback(
    (media: ImportedMedia, lat: number, lng: number, detail: string) => {
      const point: TrailPoint = {
        id: `manual-${media.id}-${Date.now()}`,
        lat,
        lng,
        title: media.name.replace(/\.[^.]+$/, ''),
        type: media.kind === 'video' ? 'video' : 'photo',
        mediaName: media.name,
        mediaKind: media.kind,
        ...(media.kind === 'video' ? { video: media.url } : { image: media.url }),
      }
      handleAddPoint(point)
      setManualPlacementMediaId(null)
      setImportReport((current) =>
        current
          ? {
              ...current,
              placed: [...current.placed, { name: media.name, detail }],
              noGps: current.noGps.filter((entry) => entry.mediaId !== media.id),
              offTrack: current.offTrack.filter(
                (entry) => entry.mediaId !== media.id,
              ),
            }
          : current,
      )
      setSaveStatus('Média placé sur la carte. Sauvegarde la carte pour partager.')
      scheduleAutosave()
    },
    [handleAddPoint, scheduleAutosave],
  )

  const handleCreatePoint = useCallback(
    (lat: number, lng: number) => {
      const mediaToPlace = manualPlacementMediaId
        ? mediaLibrary.find((media) => media.id === manualPlacementMediaId)
        : null
      if (mediaToPlace) {
        placeImportedMediaAt(mediaToPlace, lat, lng, 'placé manuellement')
        return
      }

      handleAddPoint({
        id: `point-${Date.now()}`,
        lat,
        lng,
        title: newPointTitle,
        type: 'poi',
      })
    },
    [handleAddPoint, manualPlacementMediaId, mediaLibrary, placeImportedMediaAt],
  )

  const handleAcceptEstimatedMedia = useCallback(
    (mediaId: string) => {
      const media = mediaLibrary.find((item) => item.id === mediaId)
      const estimate = importReport?.noGps.find(
        (entry) => entry.mediaId === mediaId,
      )?.placementEstimate
      if (!media || !estimate) {
        setSaveStatus('Aucune proposition à valider pour ce média.')
        return
      }
      placeImportedMediaAt(media, estimate.lat, estimate.lng, 'placé par heure')
    },
    [importReport, mediaLibrary, placeImportedMediaAt],
  )

  const handleUpdatePoint = useCallback((point: TrailPoint) => {
    setPoints((current) =>
      current.map((item) =>
        item.id === point.id
          ? // Le lieu géocodé (ajouté en tâche de fond) n'est pas dans le
            // brouillon d'édition : on le préserve pour ne pas l'effacer.
            { ...point, placeName: point.placeName ?? item.placeName }
          : item,
      ),
    )
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  const handleMovePoint = useCallback(
    (pointId: string, lat: number, lng: number) => {
      // Le point bouge → son lieu géocodé devient périmé : on l'efface pour
      // qu'il soit recalculé (le géocodeur de fond réessaiera).
      geocodeAttemptedRef.current.delete(pointId)
      setPoints((current) =>
        current.map((point) =>
          point.id === pointId
            ? { ...point, lat, lng, placeName: undefined }
            : point,
        ),
      )
      setSelectedPoint((current) =>
        current?.id === pointId
          ? { ...current, lat, lng, placeName: undefined }
          : current,
      )
      setSaveStatus('Position ajustée. Publie la carte pour la partager.')
    },
    [],
  )

  const handleDeletePoint = useCallback(
    (pointId: string) => {
      const pointToDelete = points.find((point) => point.id === pointId)
      const mediaToDelete = pointToDelete
        ? mediaLibrary.find((media) => pointUsesMedia(pointToDelete, media))
        : undefined
      const mediaStillUsed = Boolean(
        mediaToDelete &&
          points.some(
            (point) =>
              point.id !== pointId && pointUsesMedia(point, mediaToDelete),
          ),
      )

      setPoints((current) => current.filter((point) => point.id !== pointId))
      setSelectedPoint(null)
      setSaveStatus('Point supprimé.')
      scheduleAutosave()

      if (!mediaToDelete) return
      if (mediaStillUsed) {
        setSaveStatus(
          'Point supprimé. Média conservé car il est encore utilisé par un autre point.',
        )
        return
      }

      setDeletingMediaId(mediaToDelete.id)
      setSaveStatus('Point supprimé. Suppression du média associé...')
      void (async () => {
        try {
          await deleteStoredMedia(mediaToDelete)
          removeMediaLocally([mediaToDelete], { detachPoints: false })
          setSaveStatus('Point et média associé supprimés.')
          scheduleAutosave()
        } catch (deleteError) {
          const message =
            deleteError instanceof Error
              ? deleteError.message
              : 'suppression R2 impossible'
          setSaveStatus(
            `Point supprimé, mais suppression du média impossible : ${message}`,
          )
        } finally {
          setDeletingMediaId(null)
        }
      })()
    },
    [
      deleteStoredMedia,
      mediaLibrary,
      points,
      removeMediaLocally,
      scheduleAutosave,
    ],
  )

  const handleSetPointColor = useCallback((pointId: string, color: string) => {
    setPoints((current) =>
      current.map((point) =>
        point.id === pointId ? { ...point, color } : point,
      ),
    )
    setSelectedPoint((current) =>
      current?.id === pointId ? { ...current, color } : current,
    )
  }, [])

  // Verrou de position : bascule verrouillé (défaut) / déverrouillé.
  const handleToggleLock = useCallback((pointId: string) => {
    setPoints((current) =>
      current.map((point) =>
        point.id === pointId
          ? { ...point, locked: point.locked === false }
          : point,
      ),
    )
    setSelectedPoint((current) =>
      current?.id === pointId
        ? { ...current, locked: current.locked === false }
        : current,
    )
  }, [])

  // Import d'une trace GPS enregistree dans Relieo : meme principe que l'import
  // GPX (chaque trace devient une trace distincte de la carte).
  const handleImportRelioTrace = useCallback((trace: UserTraceRecord) => {
    if (trace.points.length < 2) {
      setError('Cette trace ne contient pas assez de points GPS.')
      return
    }
    setTraces((current) => [
      ...current,
      {
        id: createTraceId(),
        name: trace.name,
        points: trace.points,
      },
    ])
    setSelectedPoint(null)
    setError(null)
  }, [])

  const handleSaveProject = useCallback(async () => {
    if (!mapSlug) {
      setSaveStatus('Identifiant de carte manquant : rouvre-la depuis le tableau de bord.')
      return
    }
    const headers = await saveAuthHeaders(adminPassword)
    if (!headers) {
      setSaveStatus('Connecte-toi (Google / e-mail) ou saisis le mot de passe Studio.')
      return
    }

    // Garde : une carte privée doit avoir un code. Si on passe « privée » alors
    // qu'aucun code n'existe encore et qu'aucun n'est saisi, on bloque.
    if (accessMode === 'private' && !accessCode.trim() && !isProtected) {
      setSaveStatus('Choisis un code d’accès pour une carte privée (ou passe-la en publique).')
      return
    }

    setIsSaving(true)
    setSaveStatus('Sauvegarde...')

    try {
      // Traces au nouveau format : les points de chaque trace vivent dans un
      // fichier R2 dédié (fidélité brute, project.json léger : limite Vercel
      // ~4,5 Mo par requête). On envoie ici celles encore inline (anciennes
      // cartes chargées, import depuis l'enregistreur) avant de sauvegarder.
      const idToken = (await getIdToken()) ?? undefined
      let persistedTraces = traces
      if (traces.some((trace) => !trace.fileUrl)) {
        setSaveStatus('Envoi des traces...')
        persistedTraces = await Promise.all(
          traces.map(async (trace) => {
            if (trace.fileUrl) return trace
            const blob = serializeTracePoints(trace.points)
            const fingerprint = await traceBlobFingerprint(blob)
            const uploaded = await uploadMedia({
              file: blob,
              fingerprint,
              adminPassword,
              idToken,
              trailCode: mapSlug,
              kind: 'trace',
            })
            return { ...trace, fileUrl: uploaded.url }
          }),
        )
        setTraces(persistedTraces)
        setSaveStatus('Sauvegarde...')
      }

      // Signature calculée sur les traces PERSISTÉES (avec fileUrl), pour que
      // « modifications non sauvegardées » retombe bien à faux après le save.
      const submittedSignature = projectSignature({
        points,
        traces: persistedTraces,
        mediaLibrary,
        accessCode,
        pointsSourceName,
        slideshow: slideshowSettings,
        mapConfig,
      })

      const project: TrailProject = {
        // `track` reste présent pour la validation côté API, mais VIDE : les
        // points sont dans les fichiers R2 référencés par chaque trace.
        track: [],
        traces: tracesForStorage(persistedTraces),
        accessCode: accessCode.trim() || undefined,
        slideshow: slideshowSettings,
        mapConfig: cleanMapConfig(mapConfig),
        points: exportablePoints(points),
        mediaLibrary,
        trackSourceName:
          persistedTraces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      const response = await fetch('/api/project', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...project,
          // Identité de la carte = le slug (jamais le code d'accès secret).
          slug: mapSlug,
          // Visibilité choisie dans le studio (public = pas de code).
          accessMode,
          ...buildIndexMeta({
            title: hikeTitle,
            code: mapSlug,
            distanceMeters: stats.distanceMeters,
            elevationGainMeters: stats.elevationGainMeters,
            pointCount: points.length,
            mediaCount: mediaLibrary.length,
            // « Sauvegarder » ne change jamais le statut publié/brouillon : on
            // conserve le statut courant (une nouvelle carte démarre en
            // brouillon). La mise en ligne se fait depuis le tableau de bord.
            status: isPublished ? 'published' : 'draft',
          }),
        }),
      })

      const result = (await response.json().catch(() => null)) as {
        folder?: string
        message?: string
      } | null

      if (!response.ok) {
        throw new Error(result?.message ?? 'Sauvegarde impossible.')
      }

      const folder =
        result && 'folder' in result && typeof result.folder === 'string'
          ? result.folder
          : mapSlug
      setSavedProjectSignature(submittedSignature)
      syncStudioUrlToCode(mapSlug)
      // Après un save réussi, la garde ci-dessus garantit qu'une carte privée a
      // un code : on peut refléter la visibilité effective côté client.
      setIsProtected(accessMode === 'private')
      setSaveStatus(`Carte enregistrée : ${folder}.`)
      setError(null)
      // Fichiers R2 des traces retirées depuis le chargement : supprimés
      // (best-effort), le project.json sauvegardé ne les référence plus.
      const keptTraceUrls = new Set(
        persistedTraces
          .map((trace) => trace.fileUrl)
          .filter((url): url is string => Boolean(url)),
      )
      for (const mediaUrl of loadedTraceUrlsRef.current) {
        if (keptTraceUrls.has(mediaUrl)) continue
        void deleteUploadedMedia({
          mediaUrl,
          adminPassword,
          idToken,
          trailCode: mapSlug,
        }).catch(() => undefined)
      }
      loadedTraceUrlsRef.current = Array.from(keptTraceUrls)
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? friendlyStorageMessage(saveError.message)
          : 'Sauvegarde impossible.'
      setSaveStatus(
        `${message} Les fichiers non envoyés doivent être réimportés.`,
      )
    } finally {
      setIsSaving(false)
    }
  }, [
    accessCode,
    accessMode,
    isProtected,
    adminPassword,
    mapConfig,
    mapSlug,
    mediaLibrary,
    points,
    pointsSourceName,
    slideshowSettings,
    traces,
    hikeTitle,
    stats,
    isPublished,
  ])

  // Carte protégée : on saisit le code avant de charger le moteur cartographique.
  // `protectedGate` est posé quand le serveur n'a renvoyé que des métadonnées.
  const needsAccess = !isStudioMode && protectedGate && !accessGranted
  // On lève le voile plein écran dès que la carte est prête, que la porte de
  // code la couvre, ou que le chargement a échoué (dans les deux modes : en
  // consultation MapLibre n'est jamais monté donc `mapReady` ne viendrait
  // jamais ; en Studio, un échec de chargement ne doit pas non plus laisser le
  // voile figé à l'infini).
  const loaderDone = mapReady || needsAccess || loadFailed

  return (
    <div className={isStudioMode ? 'app-shell studio-mode' : 'app-shell'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Compass aria-hidden="true" size={22} />
          </span>
          <div>
            <p className="eyebrow">Carnet cartographique</p>
            <h1 className="brand-title">Relieo</h1>
          </div>
        </div>
        <div className="topbar-tools">
          {isStudioMode ? (
            <>
              <button
                aria-label="Retourner au dashboard"
                className="mode-link dashboard-link"
                disabled={isSaving || isAutosaving || isUploading}
                title="Dashboard"
                type="button"
                onClick={handleOpenDashboard}
              >
                <LayoutDashboard aria-hidden="true" size={16} />
                <span>Dashboard</span>
              </button>
              <button
                className="mode-link consultation-link"
                type="button"
                onClick={handleOpenConsultation}
              >
                <span>Voir la consultation</span>
              </button>
            </>
          ) : (
            <>
              {fromFeed ? (
                <a className="mode-link feed-return-link" href="/">
                  <ArrowLeft aria-hidden="true" size={16} />
                  <span>Retour au feed</span>
                </a>
              ) : null}
              {studioReturnHref ? (
                <a className="mode-link studio-return-link" href={studioReturnHref}>
                  <span>Retour au Studio</span>
                </a>
              ) : null}
              <button
                aria-label="Copier le lien de la carte"
                className={copied ? 'copy-link-button copied' : 'copy-link-button'}
                title="Copier le lien"
                type="button"
                onClick={() => void handleCopyLink()}
              >
                {copied ? (
                  <Check aria-hidden="true" size={16} />
                ) : (
                  <Copy aria-hidden="true" size={16} />
                )}
                <span>{copied ? 'Copié !' : 'Lien'}</span>
              </button>
            </>
          )}
          <StatsBar
            stats={stats}
            pointCount={points.length}
            galleryMode={isGalleryMap}
            mediaCount={mediaPoints.length}
          />
        </div>
      </header>

      <main className={isPanelOpen ? 'map-layout panel-open' : 'map-layout'}>
        <section className="map-stage" aria-label="Carte 3D interactive">
          {error ? (
            <div className="status-banner" role="alert">
              <TriangleAlert aria-hidden="true" size={18} />
              <span>{error}</span>
            </div>
          ) : null}

          {/* Bascule Auto/2D/3D : seulement si la carte laisse le choix
              (mode de vue « 3D + 2D ») ; sinon la vue est verrouillée. */}
          {mapViewMode === 'both' ? (
            <button
              type="button"
              className="terrain-badge terrain-toggle"
              onClick={handleCyclePerfMode}
              title="Mode carte : Auto / 2D / 3D"
              aria-label="Mode carte : cliquer pour basculer entre Auto, 2D et Relief 3D"
            >
              {mapFlat2D ? (
                <MapIcon aria-hidden="true" size={16} />
              ) : (
                <Mountain aria-hidden="true" size={16} />
              )}
              <span>
                {mapFlat2D ? 'Vue 2D' : 'Relief 3D'}
              </span>
            </button>
          ) : null}

          <BasemapControl basemap={basemap} onChange={handleBasemapChange} />

          {manualPlacementMedia ? (
            <div className="manual-placement-banner" role="status">
              <MapPin aria-hidden="true" size={18} />
              <span>
                <strong>Placement manuel</strong>
                <small>Clique sur la carte pour placer {manualPlacementMedia.name}</small>
              </span>
              <button
                aria-label="Annuler le placement manuel"
                title="Annuler"
                type="button"
                onClick={() => {
                  setManualPlacementMediaId(null)
                  setSaveStatus('Placement manuel annulé.')
                }}
              >
                <X aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}

          <div className="map-action-stack">
            <button
              aria-label="Recentrer la vue sur la trace"
              className="map-tool-button"
              title="Recentrer la vue"
              type="button"
              onClick={handleRecenter}
            >
              <LocateFixed aria-hidden="true" size={18} />
              <span>Recentrer</span>
            </button>
            <button
              aria-label="Lancer le diaporama de tous les médias"
              className="map-tool-button"
              data-tuto="slideshow"
              title="Diaporama de tous les médias"
              type="button"
              onClick={handleOpenSlideshow}
              disabled={slideshowItems.length === 0}
            >
              <Play aria-hidden="true" size={18} />
              <span>Diaporama</span>
            </button>
            {isStudioMode ? (
              <button
                aria-label="Personnaliser le diaporama"
                className="map-tool-button"
                title="Personnaliser le diaporama (jours, durées, médias)"
                type="button"
                onClick={() => setShowSlideshowEditor(true)}
                disabled={mediaPoints.length === 0}
              >
                <Clapperboard aria-hidden="true" size={18} />
                <span>Éditer diapo</span>
              </button>
            ) : null}
            <button
              aria-label={isStudioMode ? 'Ouvrir le studio' : 'Voir le parcours'}
              className="map-tool-button"
              data-tuto="parcours"
              title={isStudioMode ? 'Studio' : 'Parcours'}
              type="button"
              onClick={() => setIsPanelOpen(true)}
            >
              <List aria-hidden="true" size={18} />
              <span>{isStudioMode ? 'Studio' : 'Parcours'}</span>
            </button>
          </div>

          <div className="map-view-controls" aria-label="Commandes de la vue 3D">
            <button
              aria-label="Tourner à gauche"
              title="Tourner à gauche"
              type="button"
              onClick={() => sendCameraCommand('turn-left')}
            >
              <RotateCcw aria-hidden="true" size={18} />
            </button>
            <button
              aria-label="Tourner à droite"
              title="Tourner à droite"
              type="button"
              onClick={() => sendCameraCommand('turn-right')}
            >
              <RotateCw aria-hidden="true" size={18} />
            </button>
            {!mapFlat2D ? (
              <>
                <button
                  aria-label="Relever la vue"
                  title="Relever la vue"
                  type="button"
                  onClick={() => sendCameraCommand('tilt-up')}
                >
                  <ChevronUp aria-hidden="true" size={19} />
                </button>
                <button
                  aria-label="Vue plongeante"
                  title="Vue plongeante"
                  type="button"
                  onClick={() => sendCameraCommand('tilt-down')}
                >
                  <ChevronDown aria-hidden="true" size={19} />
                </button>
              </>
            ) : null}
            <button
              aria-label="Zoomer"
              title="Zoomer"
              type="button"
              onClick={() => sendCameraCommand('zoom-in')}
            >
              <Plus aria-hidden="true" size={19} />
            </button>
            <button
              aria-label="Dézoomer"
              title="Dézoomer"
              type="button"
              onClick={() => sendCameraCommand('zoom-out')}
            >
              <Minus aria-hidden="true" size={19} />
            </button>
          </div>

          {isLoading ? (
            <div className="loading-state">
              <LoaderCircle aria-hidden="true" size={26} />
              <span>Chargement</span>
            </div>
          ) : !isStudioMode && loadFailed ? (
            // Visiteur : carte introuvable ou hors ligne → écran dédié.
            <UnavailableMap />
          ) : needsAccess ? (
            // Carte non montée tant que le code n'est pas saisi (la porte couvre).
            <div className="loading-state" />
          ) : (
            <Suspense
              fallback={
                <div className="loading-state">
                  <LoaderCircle aria-hidden="true" size={26} />
                  <span>Initialisation MapLibre</span>
                </div>
              }
            >
              <MapLibreTrailMap
                traces={traces}
                points={points}
                mediaLibrary={mediaLibrary}
                basemap={basemap}
                recenterRequest={recenterRequest}
                selectedPoint={selectedPoint}
                cameraCommand={cameraCommand}
                editable={isStudioMode}
                createPointOnClick={Boolean(manualPlacementMedia)}
                pendingMediaUrls={moderationPending}
                videoPosters={videoPosters}
                pointDayKeys={dayPlan.pointDayKeys}
                traceDayKeys={dayPlan.traceDayKeys}
                activeDayKey={isStudioMode ? null : activeDayKey}
                onMovePoint={handleMovePoint}
                onCreatePoint={handleCreatePoint}
                onMarkerClick={handleMarkerClick}
                onOpenGroup={handleOpenGroup}
                onReady={() => setTilesReady(true)}
                flat2D={mapFlat2D}
              />
            </Suspense>
          )}

          <MediaRail
            points={orderedMediaPoints}
            mediaLibrary={mediaLibrary}
            videoPosters={videoPosters}
            selectedPoint={selectedPoint}
            onSelectPoint={handleSelectPoint}
          />

          {!isStudioMode &&
          dayPlan.multiDay &&
          !isLoading &&
          !loadFailed &&
          !needsAccess ? (
            <DayTimeline
              plan={dayPlan}
              traces={traces}
              activeDayKey={activeDayKey}
              onSelectDay={handleSelectDay}
            />
          ) : null}
        </section>

        {isPanelOpen ? (
          <>
            <button
              aria-label="Fermer le panneau"
              className="panel-scrim"
              type="button"
              onClick={() => setIsPanelOpen(false)}
            />
            <aside
              className={
                isStudioMode
                  ? 'detail-panel studio-panel-shell'
                  : 'detail-panel'
              }
              aria-label={isStudioMode ? 'Studio de création' : 'Détails'}
            >
              <button
                aria-label={selectedPoint ? 'Fermer' : 'Masquer le panneau'}
                className="panel-close"
                title={selectedPoint ? 'Fermer' : 'Masquer le panneau'}
                type="button"
                onClick={() =>
                  selectedPoint ? handleClosePoint() : setIsPanelOpen(false)
                }
              >
                <X aria-hidden="true" size={19} />
              </button>
              {isStudioMode ? (
                <StudioPanel
                  selectedPoint={selectedPoint}
                  points={points}
                  traces={traces}
                  stats={stats}
                  mediaLibrary={mediaLibrary}
                  accessCode={accessCode}
                  accessMode={accessMode}
                  mapKind={isGalleryMap ? 'gallery' : 'hike'}
                  viewMode={mapViewMode}
                  defaultBasemapId={configBasemap(mapConfig)}
                  onViewModeChange={handleViewModeChange}
                  onDefaultBasemapChange={handleDefaultBasemapChange}
                  moderationPending={moderationPending}
                  onSelectPoint={handleSelectPoint}
                  onClose={handleClosePoint}
                  onImportGpx={handleImportGpx}
                  onDeleteTrace={handleDeleteTrace}
                  onRenameTrace={handleRenameTrace}
                  onReorderTrace={handleReorderTrace}
                  onSetTraceColor={handleSetTraceColor}
                  onImportDriveMedia={handleImportDriveMedia}
                  onImportMedia={handleImportMedia}
                  onCleanupUnusedMedia={handleCleanupUnusedMedia}
                  onDeleteMedia={handleDeleteMedia}
                  onAcceptEstimatedMedia={handleAcceptEstimatedMedia}
                  onEstimateImportedMedia={handleEstimateImportedMedia}
                  onIgnoreImportEntry={handleIgnoreImportEntry}
                  onPlaceImportedMedia={handlePlaceImportedMedia}
                  onAttachMedia={handleAttachMedia}
                  onAddPoint={handleAddPoint}
                  onUpdatePoint={handleUpdatePoint}
                  onDeletePoint={handleDeletePoint}
                  onToggleLock={handleToggleLock}
                  onSetPointColor={handleSetPointColor}
                  onLoadRelioTraces={loadUserTraces}
                  onImportRelioTrace={handleImportRelioTrace}
                  onSaveProject={handleSaveProject}
                  onShowMedia={handleOpenLightbox}
                  onAccessCodeChange={handleAccessCodeChange}
                  onAccessModeChange={handleAccessModeChange}
                  adminPassword={adminPassword}
                  isSaving={isSaving}
                  isUploading={isUploading}
                  isDriveImporting={isDriveImporting}
                  isCleaningUnusedMedia={isCleaningUnusedMedia}
                  deletingMediaId={deletingMediaId}
                  canEstimatePlacement={canEstimatePlacement}
                  googleDriveConfigured={isGoogleDriveConfigured}
                  uploadProgress={uploadProgress}
                  importReport={importReport}
                  onDismissReport={handleDismissReport}
                  onAdminPasswordChange={handleAdminPasswordChange}
                  onDraftDirtyChange={setHasPanelDraft}
                  saveStatus={saveStatus}
                  isPublished={isPublished}
                />
              ) : (
                <PublicPanel
                  selectedPoint={selectedPoint}
                  points={points}
                  traces={traces}
                  stats={stats}
                  mediaLibrary={mediaLibrary}
                  dayPlan={dayPlan}
                  activeDayKey={activeDayKey}
                  galleryMode={isGalleryMap}
                  onSelectDay={handleSelectDay}
                  onSelectPoint={handleSelectPoint}
                  onShowMedia={handleOpenLightbox}
                  onClose={handleClosePoint}
                />
              )}
            </aside>
          </>
        ) : null}
      </main>

      {isStudioMode && showSlideshowEditor ? (
        <SlideshowEditor
          dayPlan={dayPlan}
          points={points}
          mediaPoints={mediaPoints}
          mediaLibrary={mediaLibrary}
          videoPosters={videoPosters}
          settings={slideshowSettings}
          onChange={handleSlideshowSettingsChange}
          onPreview={handlePreviewSlideshow}
          onPreviewMedia={handlePreviewEditorMedia}
          canPreview={slideshowItems.length > 0}
          onClose={() => setShowSlideshowEditor(false)}
        />
      ) : null}

      {lightbox ? (
        <MediaLightbox
          items={lightbox.items}
          startIndex={lightbox.index}
          persistKey={lightbox.persistKey}
          photoMs={slideshowSettings?.photoMs}
          breakMs={slideshowSettings?.breakMs}
          onClose={handleCloseLightbox}
        />
      ) : null}

      {!isLoading && needsAccess ? (
        <AccessGate onSubmit={handleGrantAccess} showFeedReturn={fromFeed} />
      ) : null}

      {showDashboardConfirm ? (
        <div
          aria-label="Quitter le Studio"
          aria-modal="true"
          className="confirm-overlay"
          role="dialog"
        >
          <div className="confirm-card dashboard-confirm-card">
            <strong>Quitter le Studio ?</strong>
            <p>
              Des modifications ne sont pas encore publiées. Elles seront
              perdues si vous retournez au dashboard.
            </p>
            <div className="confirm-actions">
              <button
                className="secondary-action"
                type="button"
                onClick={() => setShowDashboardConfirm(false)}
              >
                Rester dans le Studio
              </button>
              <button
                className="danger-action"
                type="button"
                onClick={openDashboard}
              >
                Quitter sans publier
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!isStudioMode && mapReady && !needsAccess && !loadFailed ? (
        // Monté (et son chunk téléchargé) seulement quand la carte est prête :
        // le délai de démarrage interne du tuto (900 ms) couvre le chargement.
        <Suspense fallback={null}>
          <ConsultTutorial
            active
            hasMedia={mediaPoints.length > 0}
            hasSlideshow={slideshowItems.length > 0}
            flat2D={mapFlat2D}
            multiDay={dayPlan.multiDay}
            gallery={isGalleryMap}
          />
        </Suspense>
      ) : null}

      <div
        className={loaderDone ? 'app-loader app-loader--done' : 'app-loader'}
        aria-hidden={loaderDone}
        role="status"
      >
        <div className="app-loader-inner">
          <span className="app-loader-logo">
            <Compass aria-hidden="true" size={34} />
          </span>
          <span className="app-loader-title">Relieo</span>
          <span className="app-loader-bar">
            <span />
          </span>
          <span className="app-loader-text">
            {loaderStuck && !loaderDone
              ? 'Le chargement prend plus de temps que prévu…'
              : 'Chargement de la carte…'}
          </span>
          {loaderStuck && !loaderDone ? (
            <button
              type="button"
              className="app-loader-retry"
              onClick={() => window.location.reload()}
            >
              Recharger
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default App
