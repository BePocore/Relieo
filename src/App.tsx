import { useCallback, useEffect, useMemo, useState } from 'react'
import { upload } from '@vercel/blob/client'
import {
  Check,
  Compass,
  Copy,
  List,
  LocateFixed,
  LoaderCircle,
  Minus,
  Mountain,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Square,
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
import { computeTrailStats } from './lib/geo'
import { parseGpx } from './lib/gpx'
import { createImportedMedia } from './lib/media'
import { cesiumIonToken, terrainStatusLabel } from './lib/terrain'
import { defaultBasemap, type BasemapId } from './lib/basemaps'
import type {
  ImportedMedia,
  PointType,
  TrailPoint,
  TrailProject,
  TrackPoint,
} from './types'

const pointTypes: PointType[] = ['photo', 'video', '360', 'poi']
const adminPasswordStorageKey = 'rando3d-admin-password'

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

const safeMediaPath = (fileName: string): string => {
  const cleanName = fileName
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `rando3d/media/${Date.now()}-${cleanName || 'media'}`
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
  const [cameraCommand, setCameraCommand] = useState<CameraCommand | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [adminPassword, setAdminPassword] = useState(() =>
    window.sessionStorage.getItem(adminPasswordStorageKey) ?? '',
  )
  const [trackSourceName, setTrackSourceName] = useState('/data/trace.gpx')
  const [pointsSourceName, setPointsSourceName] = useState('/data/points.json')
  const [isTourActive, setIsTourActive] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const loadTrail = async () => {
      try {
        setIsLoading(true)
        setError(null)

        const [gpxResponse, pointsResponse, projectResponse] = await Promise.all([
          fetch('/data/trace.gpx'),
          fetch('/data/points.json'),
          fetch('/api/project', { cache: 'no-store' }).catch(() => null),
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
        const projectContentType = projectResponse?.headers.get('content-type')

        if (
          projectResponse?.ok &&
          projectContentType?.includes('application/json')
        ) {
          const candidate = (await projectResponse.json()) as Partial<TrailProject>
          if (Array.isArray(candidate.track) && Array.isArray(candidate.points)) {
            onlineProject = {
              track: candidate.track,
              points: candidate.points,
              mediaLibrary: Array.isArray(candidate.mediaLibrary)
                ? candidate.mediaLibrary
                : [],
              trackSourceName:
                candidate.trackSourceName ?? 'carte publiee en ligne',
              pointsSourceName:
                candidate.pointsSourceName ?? 'carte publiee en ligne',
              savedAt: candidate.savedAt ?? new Date().toISOString(),
            }
          }
        }

        if (onlineProject) {
          setTrack(onlineProject.track)
          setPoints(
            onlineProject.points
              .map((point, index) => normalizePoint(point, index))
              .filter((point): point is TrailPoint => point !== null),
          )
          setMediaLibrary(onlineProject.mediaLibrary ?? [])
          setTrackSourceName(onlineProject.trackSourceName)
          setPointsSourceName(onlineProject.pointsSourceName)
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

  const stats = useMemo(() => computeTrailStats(track), [track])

  // Durée estimée selon la formule de Naismith.
  const hikingTime = useMemo(() => {
    const distanceKm = stats.distanceMeters / 1000
    if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null

    const gain = Number.isFinite(stats.elevationGainMeters)
      ? Math.max(stats.elevationGainMeters, 0)
      : 0
    const totalMinutes = Math.round((distanceKm / 5) * 60 + (gain / 300) * 30)

    if (totalMinutes < 60) return `${totalMinutes} min`

    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return minutes > 0
      ? `${hours} h ${String(minutes).padStart(2, '0')}`
      : `${hours} h`
  }, [stats])

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

  const handleRecenter = useCallback(() => {
    setRecenterRequest((current) => current + 1)
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

  const handleToggleTour = useCallback(() => {
    setIsTourActive((current) => !current)
  }, [])

  const handleTourStop = useCallback(() => {
    setIsTourActive(false)
  }, [])

  const sendCameraCommand = useCallback((type: CameraCommand['type']) => {
    setCameraCommand({ id: Date.now(), type })
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
    if (!adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio avant un import media.')
      return
    }

    setIsUploading(true)
    setSaveStatus('Envoi des medias vers Vercel...')

    const importedMedia: ImportedMedia[] = []

    try {
      for (const file of files) {
        const media = await createImportedMedia(file)
        if (!media) continue

        try {
          const blob = await upload(safeMediaPath(file.name), file, {
            access: 'public',
            handleUploadUrl: '/api/upload',
            headers: {
              'x-admin-password': adminPassword,
            },
            contentType: file.type || 'application/octet-stream',
            multipart: file.size > 10 * 1024 * 1024,
          })

          importedMedia.push({
            ...media,
            url: blob.url,
          })
        } finally {
          URL.revokeObjectURL(media.url)
        }
      }
    } catch (uploadError) {
      setSaveStatus(
        uploadError instanceof Error
          ? uploadError.message
          : 'Envoi des medias impossible.',
      )
      return
    } finally {
      setIsUploading(false)
    }

    if (importedMedia.length === 0) return

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
    setSaveStatus('Medias envoyes. Publie la carte pour partager les points.')
  }, [adminPassword, points])

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
    if (!adminPassword) {
      setSaveStatus('Saisis le mot de passe Studio.')
      return
    }

    setIsSaving(true)
    setSaveStatus('Publication en ligne...')

    try {
      const project: TrailProject = {
        track,
        points: exportablePoints(points),
        mediaLibrary: mediaLibrary.filter(
          (media) => !media.url.startsWith('blob:'),
        ),
        trackSourceName,
        pointsSourceName,
        savedAt: new Date().toISOString(),
      }

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
      setSaveStatus(
        saveError instanceof Error
          ? saveError.message
          : 'Publication en ligne impossible.',
      )
    } finally {
      setIsSaving(false)
    }
  }, [
    adminPassword,
    mediaLibrary,
    points,
    pointsSourceName,
    track,
    trackSourceName,
  ])

  return (
    <div className={isStudioMode ? 'app-shell studio-mode' : 'app-shell'}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Compass aria-hidden="true" size={22} />
          </span>
          <div>
            <p className="eyebrow">Carnet de randonnée</p>
            <h1>Randonnée 3D</h1>
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
          <StatsBar
            stats={stats}
            pointCount={points.length}
            hikingTime={hikingTime}
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

          {isTourActive ? (
            <div className="tour-indicator" role="status">
              <span className="tour-dot" aria-hidden="true" />
              <span>Tour automatique en cours</span>
            </div>
          ) : null}

          <div className="terrain-badge">
            <Mountain aria-hidden="true" size={16} />
            <span>{terrainStatusLabel}</span>
            {!cesiumIonToken && isStudioMode ? (
              <small>Token Cesium conseillé</small>
            ) : null}
          </div>

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
              aria-label={
                isTourActive
                  ? 'Arrêter le tour automatique'
                  : 'Lancer le tour automatique'
              }
              aria-pressed={isTourActive}
              className={
                isTourActive
                  ? 'map-tool-button tour-active'
                  : 'map-tool-button'
              }
              title={isTourActive ? 'Arrêter le tour' : 'Tour automatique'}
              type="button"
              onClick={handleToggleTour}
            >
              {isTourActive ? (
                <Square aria-hidden="true" size={16} fill="currentColor" />
              ) : (
                <Play aria-hidden="true" size={18} fill="currentColor" />
              )}
              <span>{isTourActive ? 'Stop' : 'Tour'}</span>
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
          ) : (
            <TrailMap
              track={track}
              points={points}
              mediaLibrary={mediaLibrary}
              basemap={basemap}
              recenterRequest={recenterRequest}
              selectedPoint={selectedPoint}
              cameraCommand={cameraCommand}
              editable={isStudioMode}
              isTourActive={isTourActive}
              onTourStop={handleTourStop}
              onMovePoint={handleMovePoint}
              onSelectPoint={handleSelectPoint}
            />
          )}

          <MediaRail
            points={mediaPoints}
            mediaLibrary={mediaLibrary}
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
                  adminPassword={adminPassword}
                  isSaving={isSaving}
                  isUploading={isUploading}
                  onAdminPasswordChange={handleAdminPasswordChange}
                  saveStatus={saveStatus}
                />
              ) : (
                <PublicPanel
                  selectedPoint={selectedPoint}
                  points={points}
                  track={track}
                  stats={stats}
                  mediaLibrary={mediaLibrary}
                  hikingTime={hikingTime}
                  onSelectPoint={handleSelectPoint}
                  onClose={handleClosePoint}
                />
              )}
            </aside>
          </>
        ) : null}
      </main>
    </div>
  )
}

export default App
