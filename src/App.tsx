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
  ChevronDown,
  ChevronUp,
  Compass,
  Copy,
  LayoutDashboard,
  List,
  LocateFixed,
  LoaderCircle,
  Map as MapIcon,
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
import { fileFingerprint, uploadMedia } from './lib/cloudUpload'
import { firebaseEnabled, getIdToken } from './portal/firebase'
import {
  createImportedMedia,
  mediaKindFromFile,
  resolvePointMedia,
} from './lib/media'
import { createMediaPreview } from './lib/mediaPreview'
import { defaultBasemap, type BasemapId } from './lib/basemaps'
import type {
  ImportedMedia,
  ImportReport,
  MediaKind,
  PointType,
  Trace,
  TrailPoint,
  TrailProject,
  TrackPoint,
  TrailStats,
  UploadProgress,
} from './types'
import { MediaLightbox } from './components/MediaLightbox'
import { AccessGate } from './components/AccessGate'
import { useVideoPosters } from './useVideoPosters'
import { useFramedThumbnails } from './useFramedThumbnails'

const MapLibreTrailMap = lazy(() =>
  import('./components/MapLibreTrailMap').then((module) => ({
    default: module.MapLibreTrailMap,
  })),
)

export type LightboxMedia = {
  src: string
  kind: MediaKind | '360'
  title?: string
}

// Construit la liste plein écran (photos / vidéos / 360) à partir de points.
// Réutilisé pour le clic sur un groupe ET le diaporama de toute la page.
const pointsToLightboxItems = (
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
): LightboxMedia[] =>
  points
    .map((point): LightboxMedia | null => {
      const media = resolvePointMedia(point, mediaLibrary)
      if (!media || (media.kind !== 'image' && media.kind !== 'video')) {
        return null
      }
      const kind =
        point.type === '360' && media.kind === 'image' ? '360' : media.kind
      return { src: media.src, kind, title: point.title }
    })
    .filter((item): item is LightboxMedia => item !== null)

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

const publicUrl = (code?: string): string => {
  const url = new URL(window.location.href)
  url.searchParams.delete('mode')
  url.searchParams.delete('new')
  if (code?.trim()) url.searchParams.set('code', code.trim())
  url.hash = ''
  return `${url.pathname}${url.search}${url.hash}` || '/'
}

const studioUrl = (): string => {
  const url = new URL(window.location.href)
  url.searchParams.set('mode', 'studio')
  url.hash = ''
  return url.toString()
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
}): string =>
  JSON.stringify({
    points: exportablePoints(input.points),
    traces: input.traces,
    mediaLibrary: input.mediaLibrary,
    accessCode: input.accessCode.trim(),
    pointsSourceName: input.pointsSourceName,
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

function App() {
  const [isStudioMode] = useState(() => isStudioUrl())
  const [studioReturnHref] = useState(() =>
    isStudioUrl() ? null : studioReturnUrl(),
  )
  const [newTrailCode] = useState(() =>
    new URLSearchParams(window.location.search).get('new')?.trim() ?? '',
  )
  // Rando ouverte depuis le dashboard : `?code=<code>` charge CETTE rando.
  // L'API déduit toujours le propriétaire du jeton Firebase.
  const [hikeCode] = useState(() =>
    new URLSearchParams(window.location.search).get('code')?.trim() ?? '',
  )
  const [hikeTitle] = useState(() =>
    new URLSearchParams(window.location.search).get('title')?.trim() ?? '',
  )
  const isLocalBlankStudio = import.meta.env.DEV && Boolean(newTrailCode)
  const [isPanelOpen, setIsPanelOpen] = useState(() => isStudioUrl())
  const [traces, setTraces] = useState<Trace[]>([])
  const [points, setPoints] = useState<TrailPoint[]>([])
  const [mediaLibrary, setMediaLibrary] = useState<ImportedMedia[]>([])
  const [basemap, setBasemap] = useState<BasemapId>(defaultBasemap)
  const [selectedPoint, setSelectedPoint] = useState<TrailPoint | null>(null)
  const [recenterRequest, setRecenterRequest] = useState(0)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Voile plein écran tant que la carte n'est pas prête. `tilesReady` = tuiles
  // de carte chargées ; `mapReady` ajoute l'attente des vignettes photo (sinon
  // le voile se lève avant que les marqueurs n'apparaissent → impression de
  // « rechargement » des photos une fois la carte affichée).
  const [tilesReady, setTilesReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const settleTimerRef = useRef<number | null>(null)
  // Le relief reste le mode principal, avec une vue 2D manuelle si nécessaire.
  const [perfMode, setPerfMode] = useState<PerfMode>('auto')
  const mapFlat2D = perfMode === 'force-2d'
  const [isSaving, setIsSaving] = useState(false)
  // Statut de publication de la carte courante : une carte reste un brouillon
  // (autosave en draft) jusqu'à publication explicite. Une carte chargée déjà
  // publiée le reste.
  const [isPublished, setIsPublished] = useState(false)
  const [isAutosaving, setIsAutosaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  )
  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const [lightbox, setLightbox] = useState<{
    items: LightboxMedia[]
    index: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [adminPassword, setAdminPassword] = useState('')
  const [pointsSourceName, setPointsSourceName] = useState('/data/points.json')
  const [accessCode, setAccessCode] = useState('')
  const [accessGranted, setAccessGranted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [savedProjectSignature, setSavedProjectSignature] = useState<string | null>(
    null,
  )
  const [hasPanelDraft, setHasPanelDraft] = useState(false)
  const [showDashboardConfirm, setShowDashboardConfirm] = useState(false)

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
    const loadedPoints = project.points
      .map((point, index) => normalizePoint(point, index))
      .filter((point): point is TrailPoint => point !== null)
    const loadedMediaLibrary = project.mediaLibrary ?? []
    const loadedAccessCode = project.accessCode ?? ''
    setTraces(loadedTraces)
    setPoints(loadedPoints)
    setMediaLibrary(loadedMediaLibrary)
    setPointsSourceName(project.pointsSourceName)
    setAccessCode(loadedAccessCode)
    setSavedProjectSignature(
      projectSignature({
        points: loadedPoints,
        traces: loadedTraces,
        mediaLibrary: loadedMediaLibrary,
        accessCode: loadedAccessCode,
        pointsSourceName: project.pointsSourceName,
      }),
    )
    setAccessGranted(
      isStudioMode || Boolean(studioReturnHref) || !loadedAccessCode,
    )
    setSelectedPoint(null)
  }, [isStudioMode, studioReturnHref])

  useEffect(() => {
    const loadTrail = async () => {
      try {
        setIsLoading(true)
        setError(null)

        if (isLocalBlankStudio) {
          const blankPoints: TrailPoint[] = []
          const blankTraces: Trace[] = []
          const blankMediaLibrary: ImportedMedia[] = []
          const blankPointsSourceName = 'Nouveau projet local'
          setTraces(blankTraces)
          setPoints(blankPoints)
          setMediaLibrary(blankMediaLibrary)
          setPointsSourceName(blankPointsSourceName)
          setAccessCode(newTrailCode)
          setSavedProjectSignature(
            projectSignature({
              points: blankPoints,
              traces: blankTraces,
              mediaLibrary: blankMediaLibrary,
              accessCode: newTrailCode,
              pointsSourceName: blankPointsSourceName,
            }),
          )
          setAccessGranted(true)
          setSelectedPoint(null)
          setIsPublished(false)
          return
        }

        // Avec un code → on charge CETTE rando via le backend local (/api).
        // Sans code → rando active (en dev, lue depuis la prod via le proxy).
        const projectEndpoint = hikeCode
          ? `/api/project?code=${encodeURIComponent(hikeCode)}`
          : import.meta.env.DEV
            ? '/prototype-api/project'
            : '/api/project'
        const projectResponse = await fetch(projectEndpoint, {
          cache: 'no-store',
        }).catch(() => null)

        let onlineProject: TrailProject | null = null
        let onlineError: string | null = null
        const projectContentType = projectResponse?.headers.get('content-type')

        if (
          projectResponse?.ok &&
          projectContentType?.includes('application/json')
        ) {
          const raw = (await projectResponse.json()) as Partial<TrailProject> & {
            hikeStatus?: string
          }
          // Une carte déjà chargée est considérée publiée sauf statut draft
          // explicite (les cartes historiques sans statut restent publiées).
          setIsPublished(raw.hikeStatus !== 'draft')
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
        applyProject(onlineProject)
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Chargement impossible.',
        )
      } finally {
        setIsLoading(false)
      }
    }

    void loadTrail()
  }, [applyProject, isLocalBlankStudio, newTrailCode, hikeCode])

  const combinedPoints = useMemo(
    () => traces.flatMap((trace) => trace.points),
    [traces],
  )
  const stats = useMemo(() => combineStats(traces), [traces])
  const currentProjectSignature = useMemo(
    () =>
      projectSignature({
        points,
        traces,
        mediaLibrary,
        accessCode,
        pointsSourceName,
      }),
    [accessCode, mediaLibrary, points, pointsSourceName, traces],
  )
  const hasUnsavedProjectChanges =
    savedProjectSignature !== null &&
    currentProjectSignature !== savedProjectSignature
  const { posters: videoPosters, ready: postersReady } = useVideoPosters(
    points,
    mediaLibrary,
  )
  const { thumbnails: framedThumbnails, ready: framedReady } =
    useFramedThumbnails(points, mediaLibrary, videoPosters)

  // On lève le voile seulement quand TOUT est réellement prêt : tuiles de carte
  // + lot complet des posters vidéo + lot complet des vignettes encadrées.
  // Un court délai de stabilisation évite un flash pendant leur installation.
  const assetsReady = postersReady && framedReady
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

  const mediaPoints = useMemo(() => {
    const filtered = points.filter(
      (point) =>
        point.type === 'photo' ||
        point.type === 'video' ||
        point.type === '360' ||
        Boolean(point.image || point.video || point.skypixelUrl),
    )

    // Route avec distance cumulée continue (trace 1 puis trace 2 ...).
    const route: Array<{ lat: number; lng: number; cum: number }> = []
    let cum = 0
    for (const trace of traces) {
      trace.points.forEach((tracePoint, index) => {
        if (index > 0) cum += distanceBetween(trace.points[index - 1], tracePoint)
        route.push({ lat: tracePoint.lat, lng: tracePoint.lng, cum })
      })
    }
    if (route.length === 0) return filtered

    // Clé de tri = distance le long du tracé du point de route le plus proche.
    const orderKey = (point: TrailPoint): number => {
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

    return filtered
      .map((point) => ({ point, key: orderKey(point) }))
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.point)
  }, [points, traces])

  // Autosave discrète : on garde un instantané à jour de tout ce qui part dans
  // le projet pour pouvoir publier en arrière-plan après un import, sans
  // dépendre des closures des handlers.
  const autosaveTimerRef = useRef<number | null>(null)
  const latestProjectRef = useRef({
    points,
    traces,
    mediaLibrary,
    accessCode,
    pointsSourceName,
    adminPassword,
    stats,
    hikeTitle,
    isPublished,
    signature: currentProjectSignature,
  })
  useEffect(() => {
    latestProjectRef.current = {
      points,
      traces,
      mediaLibrary,
      accessCode,
      pointsSourceName,
      adminPassword,
      stats,
      hikeTitle,
      isPublished,
      signature: currentProjectSignature,
    }
  }, [
    accessCode,
    adminPassword,
    currentProjectSignature,
    hikeTitle,
    isPublished,
    mediaLibrary,
    points,
    pointsSourceName,
    stats,
    traces,
  ])

  const saveProjectSilently = useCallback(async () => {
    const snapshot = latestProjectRef.current

    try {
      const project: TrailProject = {
        track: snapshot.traces.flatMap((trace) => trace.points),
        traces: snapshot.traces,
        accessCode: snapshot.accessCode.trim() || undefined,
        points: exportablePoints(snapshot.points),
        mediaLibrary: snapshot.mediaLibrary,
        trackSourceName:
          snapshot.traces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName: snapshot.pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      const headers = await saveAuthHeaders(snapshot.adminPassword)
      if (!headers) return
      setIsAutosaving(true)
      setSaveStatus('Sauvegarde automatique…')
      const response = await fetch('/api/project', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...project,
          ...buildIndexMeta({
            title: snapshot.hikeTitle,
            code: snapshot.accessCode.trim(),
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
      setSavedProjectSignature(snapshot.signature)
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
  }, [])

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
        setLightbox({
          items: [{ src: media.src, kind, title: point.title }],
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

  // Diaporama : tous les médias de la page (ordre le long du parcours), en plein
  // écran, défilables à la flèche / au swipe comme une galerie unique.
  const slideshowItems = useMemo(
    () => pointsToLightboxItems(mediaPoints, mediaLibrary),
    [mediaPoints, mediaLibrary],
  )
  const handleOpenSlideshow = useCallback(() => {
    if (slideshowItems.length > 0) setLightbox({ items: slideshowItems, index: 0 })
  }, [slideshowItems])

  const handleAdminPasswordChange = useCallback((password: string) => {
    setAdminPassword(password)
    setSaveStatus(null)
  }, [])

  const handleBasemapChange = useCallback((nextBasemap: BasemapId) => {
    setBasemap(nextBasemap)
  }, [])

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
        window.location.origin + publicUrl(accessCode),
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copie du lien impossible.')
    }
  }, [accessCode])

  const handleOpenConsultation = useCallback(() => {
    openConsultationFromStudio(accessCode)
  }, [accessCode])

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

  // Import additif : chaque GPX devient une trace distincte.
  const handleImportGpx = useCallback(async (files: File[]) => {
    const newTraces: Trace[] = []
    let failures = 0

    for (const file of files) {
      try {
        const parsedTrack = parseGpx(await file.text())
        if (parsedTrack.length < 2) {
          failures += 1
          continue
        }
        newTraces.push({
          id: createTraceId(),
          name: file.name.replace(/\.gpx$/i, ''),
          points: parsedTrack,
        })
      } catch {
        failures += 1
      }
    }

    if (newTraces.length === 0) {
      setError('Aucune trace GPX valide dans la sélection.')
      return
    }

    setTraces((current) => [...current, ...newTraces])
    setSelectedPoint(null)
    setError(
      failures > 0 ? `${failures} fichier(s) GPX ignoré(s).` : null,
    )
  }, [])

  const handleDeleteTrace = useCallback((traceId: string) => {
    setTraces((current) => current.filter((trace) => trace.id !== traceId))
  }, [])

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

  const handleGrantAccess = useCallback(
    (code: string): boolean => {
      const granted = code.trim() === accessCode.trim() && accessCode.trim() !== ''
      if (granted) {
        setAccessGranted(true)
      }
      return granted
    },
    [accessCode],
  )

  const handleImportPoints = useCallback(async (file: File) => {
    try {
      const json = JSON.parse(await file.text()) as unknown
      if (!Array.isArray(json)) {
        throw new Error('Le fichier points.json doit contenir un tableau.')
      }

      const importedPoints = json
        .map((point, index) => normalizePoint(point as TrailPoint, index))
        .filter((point): point is TrailPoint => point !== null)

      setPoints(importedPoints)
      setPointsSourceName(file.name)
      setSelectedPoint(null)
      setError(null)
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : 'Import points.json impossible.',
      )
    }
  }, [])

  const handleImportMedia = useCallback(async (files: File[]) => {
    if (!firebaseEnabled && !adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio avant un import media.')
      return
    }
    if (!accessCode.trim()) {
      setSaveStatus('Renseigne le code de la carte avant un import média.')
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

    for (const file of mediaFiles) {
      const fingerprint = await fileFingerprint(file)
      if (
        knownFingerprints.has(fingerprint) ||
        selectedFingerprints.has(fingerprint)
      ) {
        duplicates.push({ name: file.name, detail: 'deja importe' })
      } else {
        selectedFingerprints.add(fingerprint)
        uploadEntries.push({ file, fingerprint })
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
            trailCode: accessCode,
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
                trailCode: accessCode,
                kind: 'preview',
              }).catch(() => null)
            : null

          results[index] = {
            ...media,
            fingerprint,
            url: uploaded.url,
            ...(previewUpload ? { thumbnailUrl: previewUpload.url } : {}),
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
        noGps.push({ name: media.name })
        continue
      }
      const distance = distanceToTrack(
        { lat: media.lat, lng: media.lng },
        combinedPoints,
      )
      if (distance > threshold) {
        offTrack.push({
          name: media.name,
          detail: `à ${formatKilometers(distance)} du tracé`,
        })
        continue
      }
      placed.push({ name: media.name })
      placedMedia.push(media)
    }

    if (importedMedia.length > 0) {
      setMediaLibrary((current) => {
        const names = new Set(current.map((media) => media.name.toLowerCase()))
        const uniqueMedia = importedMedia.filter(
          (media) => !names.has(media.name.toLowerCase()),
        )
        return [...current, ...uniqueMedia]
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
  }, [accessCode, adminPassword, points, combinedPoints, mediaLibrary, scheduleAutosave])

  const handleDismissReport = useCallback(() => {
    setImportReport(null)
  }, [])

  // Import depuis la fiche d'un point : upload du fichier puis rattachement
  // immédiat comme média du point (photo du haut de la fiche).
  const handleAttachMedia = useCallback(
    async (pointId: string, file: File) => {
      if (!accessCode.trim()) {
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
        const fingerprint = await fileFingerprint(file)
        const existing = mediaLibrary.find(
          (item) => item.fingerprint === fingerprint,
        )
        const original = existing
          ? { url: existing.url }
          : await uploadMedia({
              file,
              fingerprint,
              adminPassword,
              idToken,
              trailCode: accessCode,
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
                trailCode: accessCode,
                kind: 'preview',
              }).catch(() => null)
            : null
        const uploaded: ImportedMedia = {
          ...media,
          fingerprint,
          url: original.url,
          ...(previewUpload ? { thumbnailUrl: previewUpload.url } : {}),
        }

        // Remplace une éventuelle entrée du même nom (URL fraîche).
        setMediaLibrary((current) => [
          ...current.filter(
            (item) => item.name.toLowerCase() !== uploaded.name.toLowerCase(),
          ),
          uploaded,
        ])

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
    [accessCode, adminPassword, mediaLibrary, scheduleAutosave],
  )

  const handleAddPoint = useCallback((point: TrailPoint) => {
    setPoints((current) => [...current, point])
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  // Appui long sur la carte (Studio) : crée un point à éditer.
  const handleCreatePoint = useCallback(
    (lat: number, lng: number) => {
      handleAddPoint({
        id: `point-${Date.now()}`,
        lat,
        lng,
        title: newPointTitle,
        type: 'poi',
      })
    },
    [handleAddPoint],
  )

  const handleUpdatePoint = useCallback((point: TrailPoint) => {
    setPoints((current) =>
      current.map((item) => (item.id === point.id ? point : item)),
    )
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  const handleMovePoint = useCallback(
    (pointId: string, lat: number, lng: number) => {
      setPoints((current) =>
        current.map((point) =>
          point.id === pointId ? { ...point, lat, lng } : point,
        ),
      )
      setSelectedPoint((current) =>
        current?.id === pointId ? { ...current, lat, lng } : current,
      )
      setSaveStatus('Position ajustée. Publie la carte pour la partager.')
    },
    [],
  )

  const handleDeletePoint = useCallback((pointId: string) => {
    setPoints((current) => current.filter((point) => point.id !== pointId))
    setSelectedPoint(null)
  }, [])

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

  const handleExportPoints = useCallback(() => {
    const blob = new Blob([JSON.stringify(exportablePoints(points), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'points.json'
    link.click()
    URL.revokeObjectURL(url)
  }, [points])

  const handleSaveProject = useCallback(async () => {
    if (isLocalBlankStudio) {
      setSaveStatus(
        'Prototype local : la publication Cloudflare sera branchée lors de l’assemblage final.',
      )
      return
    }
    if (!accessCode.trim()) {
      setSaveStatus('Le code de la carte est obligatoire pour créer son dossier R2.')
      return
    }
    const headers = await saveAuthHeaders(adminPassword)
    if (!headers) {
      setSaveStatus('Connecte-toi (Google / e-mail) ou saisis le mot de passe Studio.')
      return
    }

    setIsSaving(true)
    setSaveStatus('Publication en ligne...')
    const submittedSignature = currentProjectSignature

    try {
      const project: TrailProject = {
        // `track` reste alimenté pour la validation côté API (rétrocompat).
        track: combinedPoints,
        traces,
        accessCode: accessCode.trim() || undefined,
        points: exportablePoints(points),
        mediaLibrary,
        trackSourceName: traces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      const response = await fetch('/api/project', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          ...project,
          ...buildIndexMeta({
            title: hikeTitle,
            code: accessCode.trim(),
            distanceMeters: stats.distanceMeters,
            elevationGainMeters: stats.elevationGainMeters,
            pointCount: points.length,
            mediaCount: mediaLibrary.length,
            // Le bouton de publication rend la carte publique.
            status: 'published',
          }),
        }),
      })

      const result = (await response.json().catch(() => null)) as {
        folder?: string
        message?: string
      } | null

      if (!response.ok) {
        throw new Error(result?.message ?? 'Publication en ligne impossible.')
      }

      const folder =
        result && 'folder' in result && typeof result.folder === 'string'
          ? result.folder
          : accessCode.trim()
      setIsPublished(true)
      setSavedProjectSignature(submittedSignature)
      setSaveStatus(`Carte publiée dans Cloudflare R2 : ${folder}.`)
      setError(null)
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? friendlyStorageMessage(saveError.message)
          : 'Publication en ligne impossible.'
      setSaveStatus(
        `${message} Les fichiers non envoyés doivent être réimportés.`,
      )
    } finally {
      setIsSaving(false)
    }
  }, [
    isLocalBlankStudio,
    accessCode,
    adminPassword,
    combinedPoints,
    currentProjectSignature,
    mediaLibrary,
    points,
    pointsSourceName,
    traces,
    hikeTitle,
    stats,
  ])

  // Carte protégée : on saisit le code avant de charger le moteur cartographique.
  const needsAccess = !isStudioMode && Boolean(accessCode) && !accessGranted

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
          <StatsBar stats={stats} pointCount={points.length} />
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

          <BasemapControl basemap={basemap} onChange={handleBasemapChange} />

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
              title="Diaporama de tous les médias"
              type="button"
              onClick={handleOpenSlideshow}
              disabled={slideshowItems.length === 0}
            >
              <Play aria-hidden="true" size={18} />
              <span>Diaporama</span>
            </button>
            <button
              aria-label={isStudioMode ? 'Ouvrir le studio' : 'Voir le parcours'}
              className="map-tool-button"
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
                videoPosters={videoPosters}
                framedThumbnails={framedThumbnails}
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
            points={mediaPoints}
            mediaLibrary={mediaLibrary}
            videoPosters={videoPosters}
            selectedPoint={selectedPoint}
            onSelectPoint={handleSelectPoint}
          />
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
                aria-label="Masquer le panneau"
                className="panel-close"
                title="Masquer le panneau"
                type="button"
                onClick={() => setIsPanelOpen(false)}
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
                  pointsSourceName={pointsSourceName}
                  accessCode={accessCode}
                  onSelectPoint={handleSelectPoint}
                  onClose={handleClosePoint}
                  onImportGpx={handleImportGpx}
                  onDeleteTrace={handleDeleteTrace}
                  onRenameTrace={handleRenameTrace}
                  onSetTraceColor={handleSetTraceColor}
                  onImportPoints={handleImportPoints}
                  onImportMedia={handleImportMedia}
                  onAttachMedia={handleAttachMedia}
                  onAddPoint={handleAddPoint}
                  onUpdatePoint={handleUpdatePoint}
                  onDeletePoint={handleDeletePoint}
                  onToggleLock={handleToggleLock}
                  onSetPointColor={handleSetPointColor}
                  onExportPoints={handleExportPoints}
                  onSaveProject={handleSaveProject}
                  onShowMedia={handleOpenLightbox}
                  onAccessCodeChange={handleAccessCodeChange}
                  adminPassword={adminPassword}
                  isSaving={isSaving}
                  isUploading={isUploading}
                  uploadProgress={uploadProgress}
                  importReport={importReport}
                  onDismissReport={handleDismissReport}
                  onAdminPasswordChange={handleAdminPasswordChange}
                  onDraftDirtyChange={setHasPanelDraft}
                  saveStatus={saveStatus}
                />
              ) : (
                <PublicPanel
                  selectedPoint={selectedPoint}
                  points={points}
                  traces={traces}
                  stats={stats}
                  mediaLibrary={mediaLibrary}
                  onSelectPoint={handleSelectPoint}
                  onShowMedia={handleOpenLightbox}
                  onClose={handleClosePoint}
                />
              )}
            </aside>
          </>
        ) : null}
      </main>

      {lightbox ? (
        <MediaLightbox
          items={lightbox.items}
          startIndex={lightbox.index}
          onClose={handleCloseLightbox}
        />
      ) : null}

      {!isLoading && needsAccess ? (
        <AccessGate onSubmit={handleGrantAccess} />
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

      <div
        className={
          mapReady || needsAccess ? 'app-loader app-loader--done' : 'app-loader'
        }
        aria-hidden={mapReady || needsAccess}
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
          <span className="app-loader-text">Chargement de la carte…</span>
        </div>
      </div>
    </div>
  )
}

export default App
