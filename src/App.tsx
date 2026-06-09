import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  Compass,
  List,
  LocateFixed,
  LoaderCircle,
  Mountain,
  TriangleAlert,
  Video,
  X,
} from 'lucide-react'
import './App.css'
import { BasemapControl } from './components/BasemapControl'
import { PublicPanel } from './components/PublicPanel'
import { StudioPanel } from './components/StudioPanel'
import { StatsBar } from './components/StatsBar'
import { TrailMap } from './components/TrailMap'
import { computeTrailStats } from './lib/geo'
import { parseGpx } from './lib/gpx'
import { createImportedMedia, resolvePointMedia } from './lib/media'
import { cesiumIonToken, terrainStatusLabel } from './lib/terrain'
import { defaultBasemap, type BasemapId } from './lib/basemaps'
import type { ImportedMedia, PointType, TrailPoint, TrackPoint } from './types'

const pointTypes: PointType[] = ['photo', 'video', '360', 'poi']
const projectStorageKey = 'trail-map-project-v1'

type StoredProject = {
  points: TrailPoint[]
  pointsSourceName: string
  savedAt: string
  track: TrackPoint[]
  trackSourceName: string
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

const readStoredProject = (): StoredProject | null => {
  try {
    const rawProject = window.localStorage.getItem(projectStorageKey)
    if (!rawProject) return null

    const project = JSON.parse(rawProject) as Partial<StoredProject>
    if (!Array.isArray(project.track) || !Array.isArray(project.points)) {
      return null
    }

    return {
      track: project.track,
      points: project.points,
      trackSourceName: project.trackSourceName ?? 'sauvegarde locale',
      pointsSourceName: project.pointsSourceName ?? 'sauvegarde locale',
      savedAt: project.savedAt ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
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
    }

    if (point.mediaName) {
      if (point.mediaKind === 'video' || point.video) {
        cleanPoint.video = `/videos/${point.mediaName}`
      } else {
        cleanPoint.image = `/photos/${point.mediaName}`
      }
    } else {
      if (point.image) cleanPoint.image = point.image
      if (point.video) cleanPoint.video = point.video
    }

    return cleanPoint
  })
}

function App() {
  const [isStudioMode] = useState(() => isStudioUrl())
  const [isPanelOpen, setIsPanelOpen] = useState(() => isStudioUrl())
  const [track, setTrack] = useState<TrackPoint[]>([])
  const [points, setPoints] = useState<TrailPoint[]>([])
  const [mediaLibrary, setMediaLibrary] = useState<ImportedMedia[]>([])
  const [basemap, setBasemap] = useState<BasemapId>(() => storedBasemap())
  const [selectedPoint, setSelectedPoint] = useState<TrailPoint | null>(null)
  const [recenterRequest, setRecenterRequest] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [trackSourceName, setTrackSourceName] = useState('/data/trace.gpx')
  const [pointsSourceName, setPointsSourceName] = useState('/data/points.json')
  const mediaUrlsRef = useRef<string[]>([])

  useEffect(() => {
    const loadTrail = async () => {
      try {
        setIsLoading(true)
        setError(null)

        const [gpxResponse, pointsResponse] = await Promise.all([
          fetch('/data/trace.gpx'),
          fetch('/data/points.json'),
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

        const savedProject = readStoredProject()

        if (savedProject) {
          setTrack(savedProject.track)
          setPoints(
            savedProject.points
              .map((point, index) => normalizePoint(point, index))
              .filter((point): point is TrailPoint => point !== null),
          )
          setTrackSourceName(savedProject.trackSourceName)
          setPointsSourceName(savedProject.pointsSourceName)
        } else {
          setTrack(parseGpx(gpxText))
          setPoints(
            rawPoints
              .map((point, index) => normalizePoint(point, index))
              .filter((point): point is TrailPoint => point !== null),
          )
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
  }, [])

  useEffect(() => {
    const mediaUrls = mediaUrlsRef.current
    return () => {
      mediaUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  const stats = useMemo(() => computeTrailStats(track), [track])
  const mediaPoints = useMemo(
    () =>
      points.filter(
        (point) =>
          point.type === 'photo' ||
          point.type === 'video' ||
          point.type === '360' ||
          Boolean(point.image || point.video || point.skypixelUrl),
      ),
    [points],
  )

  const handleSelectPoint = useCallback((point: TrailPoint) => {
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  const handleClosePoint = useCallback(() => {
    setSelectedPoint(null)
  }, [])

  const handleBasemapChange = useCallback((nextBasemap: BasemapId) => {
    setBasemap(nextBasemap)
    window.localStorage.setItem('trail-basemap', nextBasemap)
  }, [])

  const handleRecenter = useCallback(() => {
    setRecenterRequest((current) => current + 1)
  }, [])

  const handleImportGpx = useCallback(async (file: File) => {
    try {
      const parsedTrack = parseGpx(await file.text())
      if (parsedTrack.length < 2) {
        throw new Error('La trace GPX ne contient pas assez de points.')
      }

      setTrack(parsedTrack)
      setTrackSourceName(file.name)
      setSelectedPoint(null)
      setError(null)
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : 'Import GPX impossible.',
      )
    }
  }, [])

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
    const importedMedia = (
      await Promise.all(files.map((file) => createImportedMedia(file)))
    )
      .filter((media): media is ImportedMedia => media !== null)

    if (importedMedia.length === 0) return

    mediaUrlsRef.current.push(...importedMedia.map((media) => media.url))
    const positionedMedia = importedMedia.filter(
      (media) => media.lat !== undefined && media.lng !== undefined,
    )

    setMediaLibrary((current) => {
      const names = new Set(current.map((media) => media.name.toLowerCase()))
      const uniqueMedia = importedMedia.filter(
        (media) => !names.has(media.name.toLowerCase()),
      )
      return [...current, ...uniqueMedia]
    })

    if (positionedMedia.length > 0) {
      const existingMediaNames = new Set(
        points
          .map((point) => point.mediaName?.toLowerCase())
          .filter((name): name is string => Boolean(name)),
      )
      const autoPoints = positionedMedia
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
          description:
            'Position recuperee automatiquement depuis les metadonnees du fichier.',
        }))

      if (autoPoints.length > 0) {
        setPoints((current) => [...current, ...autoPoints])
        setSelectedPoint(autoPoints[0])
        setIsPanelOpen(true)
      }
    }

    setError(null)
  }, [points])

  const handleAddPoint = useCallback((point: TrailPoint) => {
    setPoints((current) => [...current, point])
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  const handleUpdatePoint = useCallback((point: TrailPoint) => {
    setPoints((current) =>
      current.map((item) => (item.id === point.id ? point : item)),
    )
    setSelectedPoint(point)
    setIsPanelOpen(true)
  }, [])

  const handleDeletePoint = useCallback((pointId: string) => {
    setPoints((current) => current.filter((point) => point.id !== pointId))
    setSelectedPoint(null)
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

  const handleSaveProject = useCallback(() => {
    try {
      const project: StoredProject = {
        track,
        points: exportablePoints(points),
        trackSourceName,
        pointsSourceName,
        savedAt: new Date().toISOString(),
      }

      window.localStorage.setItem(projectStorageKey, JSON.stringify(project))
      setSaveStatus('Carte sauvegardee dans ce navigateur.')
      setError(null)
    } catch {
      setSaveStatus(null)
      setError('Sauvegarde impossible dans ce navigateur.')
    }
  }, [points, pointsSourceName, track, trackSourceName])

  return (
    <div className={isStudioMode ? 'app-shell studio-mode' : 'app-shell'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Compass aria-hidden="true" size={24} />
          </span>
          <div>
            <p className="eyebrow">Carte interactive</p>
            <h1>Randonnée 3D</h1>
          </div>
        </div>
        <div className="topbar-tools">
          {isStudioMode ? (
            <a className="mode-link" href={publicUrl()}>
              Voir la consultation
            </a>
          ) : null}
          <StatsBar stats={stats} pointCount={points.length} />
        </div>
      </header>

      {error ? (
        <div className="status-banner" role="alert">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>{error}</span>
        </div>
      ) : null}

      <main
        className={
          isPanelOpen ? 'map-layout mobile-panel-open' : 'map-layout'
        }
      >
        <section className="map-stage" aria-label="Carte 3D interactive">
          <div className="terrain-badge">
            <Mountain aria-hidden="true" size={16} />
            <span>{terrainStatusLabel}</span>
            {!cesiumIonToken && isStudioMode ? (
              <small>Token Cesium conseillé</small>
            ) : null}
          </div>
          <BasemapControl
            basemap={basemap}
            onChange={handleBasemapChange}
          />
          <button
            aria-label="Recentrer la vue sur la trace"
            className="map-reset-button"
            title="Recentrer la vue"
            type="button"
            onClick={handleRecenter}
          >
            <LocateFixed aria-hidden="true" size={16} />
            <span>Recentrer</span>
          </button>
          <button
            aria-label={
              isStudioMode
                ? 'Ouvrir le studio'
                : 'Ouvrir les points de passage'
            }
            className="map-panel-button"
            title={isStudioMode ? 'Studio' : 'Points'}
            type="button"
            onClick={() => setIsPanelOpen(true)}
          >
            <List aria-hidden="true" size={16} />
            <span>{isStudioMode ? 'Studio' : 'Points'}</span>
          </button>
          {mediaPoints.length > 0 ? (
            <div
              aria-label="Photos et videos du parcours"
              className="mobile-media-strip"
            >
              {mediaPoints.map((point) => {
                const media = resolvePointMedia(point, mediaLibrary)
                const isSelected =
                  selectedPoint?.id === point.id ||
                  (!selectedPoint?.id && selectedPoint?.title === point.title)

                return (
                  <button
                    className={
                      isSelected
                        ? 'mobile-media-item active'
                        : 'mobile-media-item'
                    }
                    key={point.id ?? point.title}
                    type="button"
                    onClick={() => handleSelectPoint(point)}
                  >
                    {media?.kind === 'image' ? (
                      <img src={media.src} alt="" />
                    ) : (
                      <span className={`mobile-media-fallback type-${point.type}`}>
                        {point.type === 'video' ? (
                          <Video aria-hidden="true" size={18} />
                        ) : point.type === '360' ? (
                          '360'
                        ) : (
                          <Camera aria-hidden="true" size={18} />
                        )}
                      </span>
                    )}
                    <span className="mobile-media-label">{point.title}</span>
                  </button>
                )
              })}
            </div>
          ) : null}

          {isLoading ? (
            <div className="loading-state">
              <LoaderCircle aria-hidden="true" size={26} />
              <span>Chargement</span>
            </div>
          ) : null}

           {!isLoading ? (
             <TrailMap
               key={basemap}
               track={track}
               points={points}
               mediaLibrary={mediaLibrary}
               basemap={basemap}
               recenterRequest={recenterRequest}
               selectedPoint={selectedPoint}
              onSelectPoint={handleSelectPoint}
            />
          ) : null}
        </section>

        <aside
          className="detail-panel"
          aria-label={isStudioMode ? 'Studio de création' : 'Détails'}
        >
          <button
            aria-label="Masquer le panneau"
            className="mobile-panel-close"
            title="Masquer le panneau"
            type="button"
            onClick={() => setIsPanelOpen(false)}
          >
            <X aria-hidden="true" size={18} />
          </button>
          {isStudioMode ? (
            <StudioPanel
              selectedPoint={selectedPoint}
              points={points}
              track={track}
              stats={stats}
              mediaLibrary={mediaLibrary}
              trackSourceName={trackSourceName}
              pointsSourceName={pointsSourceName}
              onSelectPoint={handleSelectPoint}
              onClose={handleClosePoint}
              onImportGpx={handleImportGpx}
              onImportPoints={handleImportPoints}
              onImportMedia={handleImportMedia}
              onAddPoint={handleAddPoint}
              onUpdatePoint={handleUpdatePoint}
              onDeletePoint={handleDeletePoint}
              onExportPoints={handleExportPoints}
              onSaveProject={handleSaveProject}
              saveStatus={saveStatus}
            />
          ) : (
            <PublicPanel
              selectedPoint={selectedPoint}
              points={points}
              track={track}
              stats={stats}
              mediaLibrary={mediaLibrary}
              onSelectPoint={handleSelectPoint}
              onClose={handleClosePoint}
            />
          )}
        </aside>
      </main>
    </div>
  )
}

export default App
