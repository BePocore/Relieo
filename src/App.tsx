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
import { TrailMap } from './components/TrailMap'
import type { CameraCommand } from './components/TrailMap'
import { computeTrailStats, distanceBetween } from './lib/geo'
import { parseGpx } from './lib/gpx'
import { fileFingerprint, uploadMedia } from './lib/cloudUpload'
import {
  createImportedMedia,
  mediaKindFromFile,
  resolvePointMedia,
} from './lib/media'
import { createMediaPreview } from './lib/mediaPreview'
import { loadLocalProject, saveLocalProject } from './lib/projectBackup'
import { cesiumIonToken, useWorldTerrain } from './lib/terrain'
import { createFpsWatchdog, getInitialPerfTier } from './lib/deviceTier'
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
const adminPasswordStorageKey = 'rando3d-admin-password'
export const newPointTitle = 'Nouveau point'
const accessGrantStorageKey = 'rando3d-access-granted'

// Réglage de performance carte : Auto (détection), ou forcé en 2D / 3D.
type PerfMode = 'auto' | 'force-2d' | 'force-3d'
const perfModeStorageKey = 'rando3d-perf-mode'
const readPerfMode = (): PerfMode => {
  const stored = window.localStorage.getItem(perfModeStorageKey)
  return stored === 'force-2d' || stored === 'force-3d' ? stored : 'auto'
}

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

const publicUrl = (): string => {
  const url = new URL(window.location.href)
  url.searchParams.delete('mode')
  url.hash = ''
  return `${url.pathname}${url.search}${url.hash}` || '/'
}

const studioUrl = (): string => {
  const url = new URL(window.location.href)
  url.searchParams.set('mode', 'studio')
  url.hash = ''
  return url.toString()
}

// Accès Studio caché : appui long sur le logo (boussole).
const studioLongPressMs = 1_500

const storedBasemap = (): BasemapId => {
  const stored = window.localStorage.getItem('trail-basemap')
  if (stored === 'relief') return defaultBasemap

  if (
    stored === 'satellite' ||
    stored === 'topo' ||
    stored === 'streets'
  ) {
    return stored
  }

  return defaultBasemap
}

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
    ? 'Stockage en ligne sature. La copie locale de ton projet est conservee.'
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
  const mapEngine =
    new URLSearchParams(window.location.search).get('engine') === 'cesium'
      ? 'cesium'
      : 'maplibre'
  const [isStudioMode] = useState(() => isStudioUrl())
  const [isPanelOpen, setIsPanelOpen] = useState(() => isStudioUrl())
  const [traces, setTraces] = useState<Trace[]>([])
  const [points, setPoints] = useState<TrailPoint[]>([])
  const [mediaLibrary, setMediaLibrary] = useState<ImportedMedia[]>([])
  const [basemap, setBasemap] = useState<BasemapId>(() => storedBasemap())
  const [selectedPoint, setSelectedPoint] = useState<TrailPoint | null>(null)
  const [recenterRequest, setRecenterRequest] = useState(0)
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  // Voile plein écran tant que la carte n'est pas prête. `tilesReady` = tuiles
  // du globe chargées ; `mapReady` ajoute l'attente des vignettes photo (sinon
  // le voile se lève avant que les marqueurs n'apparaissent → impression de
  // « rechargement » des photos une fois la carte affichée).
  const [tilesReady, setTilesReady] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const settleTimerRef = useRef<number | null>(null)
  // Mode performance carte (2D allégé sur appareils faibles).
  const [perfMode, setPerfMode] = useState<PerfMode>(() => readPerfMode())
  const [autoTier, setAutoTier] = useState<'high' | 'low'>(() =>
    getInitialPerfTier(),
  )
  // 2D effectif : terrain forcé plat (env), ou réglage manuel, ou auto faible.
  const flat2D =
    !useWorldTerrain ||
    perfMode === 'force-2d' ||
    (perfMode === 'auto' && autoTier === 'low')
  // Le prototype MapLibre garde le relief en mode Auto. Le bouton permet
  // toujours de forcer explicitement la 2D pour comparer.
  const mapFlat2D =
    perfMode === 'force-2d' || (mapEngine === 'cesium' && flat2D)
  const [isSaving, setIsSaving] = useState(false)
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
  const [localSaveStatus, setLocalSaveStatus] = useState<string | null>(null)
  const [adminPassword, setAdminPassword] = useState(() =>
    window.sessionStorage.getItem(adminPasswordStorageKey) ?? '',
  )
  const [pointsSourceName, setPointsSourceName] = useState('/data/points.json')
  const [accessCode, setAccessCode] = useState('')
  const [accessGranted, setAccessGranted] = useState(false)
  const [copied, setCopied] = useState(false)

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
    setTraces(loadedTraces)
    setPoints(
      project.points
        .map((point, index) => normalizePoint(point, index))
        .filter((point): point is TrailPoint => point !== null),
    )
    setMediaLibrary(project.mediaLibrary ?? [])
    setPointsSourceName(project.pointsSourceName)
    const code = project.accessCode ?? ''
    setAccessCode(code)
    setAccessGranted(
      isStudioMode ||
        !code ||
        window.sessionStorage.getItem(accessGrantStorageKey) === code,
    )
    setSelectedPoint(null)
  }, [isStudioMode])

  useEffect(() => {
    const loadTrail = async () => {
      try {
        setIsLoading(true)
        setError(null)

        const [gpxResponse, pointsResponse, projectResponse, localProject] = await Promise.all([
          fetch('/data/trace.gpx'),
          fetch('/data/points.json'),
          fetch(
            import.meta.env.DEV ? '/prototype-api/project' : '/api/project',
            { cache: 'no-store' },
          ).catch(() => null),
          loadLocalProject().catch(() => null),
        ])

        if (!gpxResponse.ok) {
          throw new Error('Impossible de charger /data/trace.gpx.')
        }

        if (!pointsResponse.ok) {
          throw new Error('Impossible de charger /data/points.json.')
        }

        const [gpxText, rawPoints] = await Promise.all([
          gpxResponse.text(),
          pointsResponse.json() as Promise<TrailPoint[]>,
        ])

        let onlineProject: TrailProject | null = null
        let onlineError: string | null = null
        const projectContentType = projectResponse?.headers.get('content-type')

        if (
          projectResponse?.ok &&
          projectContentType?.includes('application/json')
        ) {
          onlineProject = normalizeProject(
            (await projectResponse.json()) as Partial<TrailProject>,
          )
        } else if (projectResponse) {
          const result = (await projectResponse.json().catch(() => null)) as {
            message?: string
          } | null
          onlineError = result?.message ?? 'Carte en ligne indisponible.'
        }

        if (onlineProject) {
          applyProject(onlineProject)
          setLocalSaveStatus('Projet en ligne charge et copie locale active.')
        } else if (localProject && normalizeProject(localProject)) {
          applyProject(normalizeProject(localProject) as TrailProject)
          setSaveStatus(
            `${friendlyStorageMessage(onlineError ?? 'Cloud indisponible.')} Projet local restaure.`,
          )
          setLocalSaveStatus('Copie locale restauree sur cet appareil.')
        } else {
          setTraces([
            { id: createTraceId(), name: 'Trace', points: parseGpx(gpxText) },
          ])
          setPoints(
            rawPoints
              .map((point, index) => normalizePoint(point, index))
              .filter((point): point is TrailPoint => point !== null),
          )
          setAccessGranted(true)
          if (onlineError && isStudioMode) {
            setSaveStatus(friendlyStorageMessage(onlineError))
          }
        }
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
  }, [applyProject, isStudioMode, mapEngine])

  const combinedPoints = useMemo(
    () => traces.flatMap((trace) => trace.points),
    [traces],
  )
  const stats = useMemo(() => combineStats(traces), [traces])
  const { posters: videoPosters, ready: postersReady } = useVideoPosters(
    points,
    mediaLibrary,
  )
  const { thumbnails: framedThumbnails, ready: framedReady } =
    useFramedThumbnails(points, mediaLibrary, videoPosters)

  // On lève le voile seulement quand TOUT est réellement prêt : tuiles du globe
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
  })
  useEffect(() => {
    latestProjectRef.current = {
      points,
      traces,
      mediaLibrary,
      accessCode,
      pointsSourceName,
      adminPassword,
    }
  })

  const localSaveTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (isLoading) return
    if (localSaveTimerRef.current !== null) {
      window.clearTimeout(localSaveTimerRef.current)
    }

    localSaveTimerRef.current = window.setTimeout(() => {
      const snapshot = latestProjectRef.current
      const project: TrailProject = {
        track: snapshot.traces.flatMap((trace) => trace.points),
        traces: snapshot.traces,
        accessCode: snapshot.accessCode.trim() || undefined,
        points: exportablePoints(snapshot.points),
        mediaLibrary: snapshot.mediaLibrary.filter(
          (media) => !media.url.startsWith('blob:'),
        ),
        trackSourceName:
          snapshot.traces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName: snapshot.pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      void saveLocalProject(project)
        .then(() => {
          setLocalSaveStatus(
            `Copie locale enregistree a ${new Date().toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            })}.`,
          )
        })
        .catch(() => {
          setLocalSaveStatus('Copie locale impossible sur ce navigateur.')
        })
    }, 500)

    return () => {
      if (localSaveTimerRef.current !== null) {
        window.clearTimeout(localSaveTimerRef.current)
      }
    }
  }, [accessCode, isLoading, mediaLibrary, points, pointsSourceName, traces])

  const saveProjectSilently = useCallback(async () => {
    const snapshot = latestProjectRef.current
    if (!snapshot.adminPassword) return

    try {
      const project: TrailProject = {
        track: snapshot.traces.flatMap((trace) => trace.points),
        traces: snapshot.traces,
        accessCode: snapshot.accessCode.trim() || undefined,
        points: exportablePoints(snapshot.points),
        mediaLibrary: snapshot.mediaLibrary.filter(
          (media) => !media.url.startsWith('blob:'),
        ),
        trackSourceName:
          snapshot.traces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName: snapshot.pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      setSaveStatus('Sauvegarde automatique…')
      const response = await fetch('/api/project', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': snapshot.adminPassword,
        },
        body: JSON.stringify(project),
      })

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          message?: string
        } | null
        throw new Error(result?.message ?? 'Sauvegarde auto impossible.')
      }
      setSaveStatus('Modifs sauvegardées automatiquement.')
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? friendlyStorageMessage(saveError.message)
          : 'Sauvegarde auto impossible.'
      setSaveStatus(
        `Sauvegarde en ligne impossible : ${message} Copie locale conservee.`,
      )
    }
  }, [])

  // Publie en arrière-plan ~1,5 s après le dernier import (debounce), pour ne
  // plus perdre des médias déjà envoyés si la page se recharge.
  const scheduleAutosave = useCallback(() => {
    if (!latestProjectRef.current.adminPassword) return
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
    if (password) {
      window.sessionStorage.setItem(adminPasswordStorageKey, password)
    } else {
      window.sessionStorage.removeItem(adminPasswordStorageKey)
    }
    setSaveStatus(null)
  }, [])

  const handleBasemapChange = useCallback((nextBasemap: BasemapId) => {
    setBasemap(nextBasemap)
    window.localStorage.setItem('trail-basemap', nextBasemap)
  }, [])

  // Bascule manuelle du mode carte : Auto → 2D → 3D → Auto (persistée).
  const handleCyclePerfMode = useCallback(() => {
    setPerfMode((current) => {
      const next: PerfMode =
        current === 'auto'
          ? 'force-2d'
          : current === 'force-2d'
            ? 'force-3d'
            : 'auto'
      window.localStorage.setItem(perfModeStorageKey, next)
      return next
    })
  }, [])

  // Détection auto : en 3D + mode Auto, on surveille le framerate ; si l'appareil
  // rame, on bascule définitivement en 2D pour la session (jamais l'inverse).
  useEffect(() => {
    if (!mapReady || mapFlat2D || perfMode !== 'auto' || !useWorldTerrain) return
    const watchdog = createFpsWatchdog(() => setAutoTier('low'))
    return () => watchdog.stop()
  }, [mapReady, mapFlat2D, perfMode])

  const handleRecenter = useCallback(() => {
    setRecenterRequest((current) => current + 1)
  }, [])

  const logoPressTimer = useRef<number | null>(null)

  const handleLogoPressStart = useCallback(() => {
    if (logoPressTimer.current !== null) return
    logoPressTimer.current = window.setTimeout(() => {
      logoPressTimer.current = null
      window.location.assign(studioUrl())
    }, studioLongPressMs)
  }, [])

  const handleLogoPressEnd = useCallback(() => {
    if (logoPressTimer.current !== null) {
      window.clearTimeout(logoPressTimer.current)
      logoPressTimer.current = null
    }
  }, [])

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        window.location.origin + publicUrl(),
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copie du lien impossible.')
    }
  }, [])

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
        window.sessionStorage.setItem(accessGrantStorageKey, accessCode)
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
    if (!adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio avant un import media.')
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
  }, [adminPassword, points, combinedPoints, mediaLibrary, scheduleAutosave])

  const handleDismissReport = useCallback(() => {
    setImportReport(null)
  }, [])

  // Import depuis la fiche d'un point : upload du fichier puis rattachement
  // immédiat comme média du point (photo du haut de la fiche).
  const handleAttachMedia = useCallback(
    async (pointId: string, file: File) => {
      if (!adminPassword) {
        setSaveStatus('Saisis le mot de passe Studio avant un import media.')
        return
      }
      if (mediaKindFromFile(file) === null) {
        setSaveStatus('Format non reconnu : photo ou vidéo attendue.')
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
          : await uploadMedia({ file, fingerprint, adminPassword })
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
    [adminPassword, mediaLibrary, scheduleAutosave],
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

  const handleExportProject = useCallback(() => {
    const project: TrailProject = {
      track: combinedPoints,
      traces,
      accessCode: accessCode.trim() || undefined,
      points: exportablePoints(points),
      mediaLibrary: mediaLibrary.filter(
        (media) => !media.url.startsWith('blob:'),
      ),
      trackSourceName: traces.map((trace) => trace.name).join(' · ') || 'Traces',
      pointsSourceName,
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `rando3d-projet-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setLocalSaveStatus('Fichier projet complet telecharge.')
  }, [accessCode, combinedPoints, mediaLibrary, points, pointsSourceName, traces])

  const handleImportProject = useCallback(
    async (file: File) => {
      try {
        const project = normalizeProject(
          JSON.parse(await file.text()) as Partial<TrailProject>,
        )
        if (!project) {
          throw new Error('Ce fichier ne contient pas un projet Rando 3D valide.')
        }
        applyProject(project)
        await saveLocalProject({ ...project, savedAt: new Date().toISOString() })
        setError(null)
        setSaveStatus('Projet restaure. Tu peux maintenant le publier en ligne.')
        setLocalSaveStatus('Projet restaure et conserve localement.')
      } catch (importError) {
        setError(
          importError instanceof Error
            ? importError.message
            : 'Restauration du projet impossible.',
        )
      }
    },
    [applyProject],
  )

  const handleSaveProject = useCallback(async () => {
    if (!adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio.')
      return
    }

    setIsSaving(true)
    setSaveStatus('Publication en ligne...')

    try {
      const project: TrailProject = {
        // `track` reste alimenté pour la validation côté API (rétrocompat).
        track: combinedPoints,
        traces,
        accessCode: accessCode.trim() || undefined,
        points: exportablePoints(points),
        mediaLibrary: mediaLibrary.filter(
          (media) => !media.url.startsWith('blob:'),
        ),
        trackSourceName: traces.map((trace) => trace.name).join(' · ') || 'Traces',
        pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      await saveLocalProject(project)
      setLocalSaveStatus('Copie locale enregistree avant publication.')

      const response = await fetch('/api/project', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-password': adminPassword,
        },
        body: JSON.stringify(project),
      })

      const result = (await response.json().catch(() => null)) as {
        message?: string
      } | null

      if (!response.ok) {
        throw new Error(result?.message ?? 'Publication en ligne impossible.')
      }

      setSaveStatus('Carte publiee en ligne pour tous les appareils.')
      setError(null)
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? friendlyStorageMessage(saveError.message)
          : 'Publication en ligne impossible.'
      setSaveStatus(
        `${message} La copie locale reste enregistree sur cet appareil.`,
      )
    } finally {
      setIsSaving(false)
    }
  }, [
    accessCode,
    adminPassword,
    combinedPoints,
    mediaLibrary,
    points,
    pointsSourceName,
    traces,
  ])

  // Carte protégée : on saisit le code AVANT de charger la carte (Cesium est
  // lourd, inutile de le charger pour quelqu'un qui n'a pas encore l'accès).
  const needsAccess = !isStudioMode && Boolean(accessCode) && !accessGranted

  return (
    <div
      className={`${isStudioMode ? 'app-shell studio-mode' : 'app-shell'}${
        mapEngine === 'maplibre' ? ' maplibre-prototype' : ''
      }`}
    >
      <header className="topbar">
        <div className="brand">
          <span
            className="brand-icon"
            onPointerDown={handleLogoPressStart}
            onPointerUp={handleLogoPressEnd}
            onPointerLeave={handleLogoPressEnd}
            onPointerCancel={handleLogoPressEnd}
          >
            <Compass aria-hidden="true" size={22} />
          </span>
          <div>
            <p className="eyebrow">Carnet de randonnée</p>
            <h1 className="brand-title">Randonnée 3D</h1>
          </div>
        </div>
        <div className="topbar-tools">
          {isStudioMode ? (
            <a className="mode-link" href={publicUrl()}>
              Voir la consultation
            </a>
          ) : (
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
              {perfMode === 'force-2d'
                ? 'Vue 2D'
                : perfMode === 'force-3d'
                  ? 'Relief 3D'
                  : mapEngine === 'maplibre'
                    ? 'Relief 3D'
                    : `Auto · ${mapFlat2D ? '2D' : '3D'}`}
            </span>
            {mapEngine === 'cesium' && !cesiumIonToken && isStudioMode ? (
              <small>Token Cesium conseillé</small>
            ) : null}
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
          ) : mapEngine === 'maplibre' ? (
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
          ) : (
            <TrailMap
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
                  onExportProject={handleExportProject}
                  onImportProject={handleImportProject}
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
                  saveStatus={saveStatus}
                  localSaveStatus={localSaveStatus}
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
          <span className="app-loader-title">Randonnée 3D</span>
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
