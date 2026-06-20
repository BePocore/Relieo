import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Crosshair,
  Download,
  HardDrive,
  Map,
  MapPin,
  Mountain,
  Pause,
  Play,
  Route,
  Satellite,
  Square,
  Trash2,
} from 'lucide-react'
import type { TrackPoint } from '../types'
import { computeTrailStats, distanceBetween } from '../lib/geo'
import { setPendingTraceImport } from '../lib/pendingTraceImport'
import {
  deleteUserTrace,
  downloadTraceGpx,
  LOCAL_TRACE_DRAFT_KEY,
  loadUserTraces,
  saveUserTrace,
  type UserTraceRecord,
} from './userTraces'

type RecorderStatus = 'idle' | 'recording' | 'paused' | 'saving' | 'saved'

type ActiveTraceMeta = {
  id: string
  name: string
  createdAt: string
  startedAt: string
  startedAtMs: number
}

type LocalTraceDraft = ActiveTraceMeta & {
  updatedAt: string
  autosavedAt?: string
  elapsedMs: number
  points: TrackPoint[]
}

type WakeLockSentinelLike = {
  release: () => Promise<void>
  addEventListener?: (type: 'release', listener: () => void) => void
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>
  }
}

const CLOUD_AUTOSAVE_INTERVAL_MS = 10 * 60 * 1000
const MAX_ACCEPTED_ACCURACY_METERS = 80
const MAX_REASONABLE_SPEED_METERS_PER_SECOND = 20

const isTrackPoint = (value: unknown): value is TrackPoint => {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return (
    typeof point.lat === 'number' &&
    Number.isFinite(point.lat) &&
    typeof point.lng === 'number' &&
    Number.isFinite(point.lng)
  )
}

const readLocalTraceDraft = (): LocalTraceDraft | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LOCAL_TRACE_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LocalTraceDraft>
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.startedAtMs !== 'number' ||
      !Array.isArray(parsed.points)
    ) {
      return null
    }
    return {
      id: parsed.id,
      name: parsed.name,
      createdAt: parsed.createdAt,
      startedAt: parsed.startedAt,
      startedAtMs: parsed.startedAtMs,
      updatedAt: parsed.updatedAt,
      autosavedAt: parsed.autosavedAt,
      elapsedMs:
        typeof parsed.elapsedMs === 'number' && Number.isFinite(parsed.elapsedMs)
          ? parsed.elapsedMs
          : Math.max(0, Date.now() - Date.parse(parsed.startedAt)),
      points: parsed.points.filter(isTrackPoint),
    }
  } catch {
    return null
  }
}

const writeLocalTraceDraft = (draft: LocalTraceDraft): void => {
  try {
    window.localStorage.setItem(LOCAL_TRACE_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // Le stockage local peut etre plein ou bloque par le navigateur.
  }
}

const clearLocalTraceDraft = (): void => {
  try {
    window.localStorage.removeItem(LOCAL_TRACE_DRAFT_KEY)
  } catch {
    // Rien a faire : la sauvegarde R2 reste le filet suivant.
  }
}

const formatDistance = (meters: number): string => {
  if (meters >= 1000) {
    return `${(meters / 1000).toLocaleString('fr-FR', {
      maximumFractionDigits: 2,
    })} km`
  }
  return `${Math.round(meters).toLocaleString('fr-FR')} m`
}

const formatElevation = (meters: number): string =>
  `${Math.round(meters).toLocaleString('fr-FR')} m`

const formatDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const formatTimer = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const formatPace = (seconds: number, meters: number): string => {
  if (meters < 50 || seconds <= 0) return '-'
  const secondsPerKm = seconds / (meters / 1000)
  const minutes = Math.floor(secondsPerKm / 60)
  const remainingSeconds = Math.round(secondsPerKm % 60)
  return `${minutes}'${String(remainingSeconds).padStart(2, '0')}"`
}

const formatDateTime = (value: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

const traceIdFromDate = (date: Date): string =>
  `trace-${date.toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`

const defaultTraceName = (date: Date): string =>
  `Trace ${new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)}`

const traceStatusLabel = (trace: UserTraceRecord): string | null => {
  if (trace.status === 'recording') return 'Brouillon auto'
  if (trace.status === 'interrupted') return 'Interrompue'
  return null
}

const positionErrorMessage = (error: GeolocationPositionError): string => {
  if (error.code === error.PERMISSION_DENIED) {
    return 'Autorise la localisation pour enregistrer une trace.'
  }
  if (error.code === error.TIMEOUT) {
    return 'Signal GPS trop lent. Reessaie dehors ou pres dune fenetre.'
  }
  return 'Position GPS indisponible pour le moment.'
}

const pointFromPosition = (position: GeolocationPosition): TrackPoint => {
  const point: TrackPoint = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    time: new Date(position.timestamp || Date.now()).toISOString(),
  }
  if (typeof position.coords.altitude === 'number') {
    point.ele = position.coords.altitude
  }
  return point
}

const previewViewBox = { width: 320, height: 350, pad: 34 }

const previewPath = (points: TrackPoint[]): {
  d: string
  start: { x: number; y: number } | null
  end: { x: number; y: number } | null
} => {
  if (points.length === 0) return { d: '', start: null, end: null }
  const lngs = points.map((point) => point.lng)
  const lats = points.map((point) => point.lat)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const lngSpan = Math.max(maxLng - minLng, 0.0001)
  const latSpan = Math.max(maxLat - minLat, 0.0001)
  const drawableWidth = previewViewBox.width - previewViewBox.pad * 2
  const drawableHeight = previewViewBox.height - previewViewBox.pad * 2
  const projected = points.map((point) => ({
    x: previewViewBox.pad + ((point.lng - minLng) / lngSpan) * drawableWidth,
    y:
      previewViewBox.pad +
      ((maxLat - point.lat) / latSpan) * drawableHeight,
  }))
  const d = projected
    .map((point, index) =>
      `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(' ')

  return {
    d,
    start: projected[0] ?? null,
    end: projected[projected.length - 1] ?? null,
  }
}

function TracePreview({ points }: { points: TrackPoint[] }) {
  const geometry = useMemo(() => previewPath(points), [points])
  return (
    <div className="trace-preview" aria-label="Apercu du trace en direct">
      {points.length < 2 ? (
        <div className="trace-preview-empty">
          <Satellite size={28} />
          <strong>Signal en attente</strong>
          <span>Le trace apparait des les premiers metres.</span>
        </div>
      ) : null}
      <svg
        aria-hidden="true"
        className="trace-preview-svg"
        viewBox={`0 0 ${previewViewBox.width} ${previewViewBox.height}`}
      >
        <path className="trace-preview-path-shadow" d={geometry.d} />
        <path className="trace-preview-path" d={geometry.d} />
        {geometry.start ? (
          <circle className="trace-preview-start" cx={geometry.start.x} cy={geometry.start.y} r="7" />
        ) : null}
        {geometry.end ? (
          <>
            <circle className="trace-preview-end-pulse" cx={geometry.end.x} cy={geometry.end.y} r="17" />
            <circle className="trace-preview-end" cx={geometry.end.x} cy={geometry.end.y} r="9" />
          </>
        ) : null}
      </svg>
    </div>
  )
}

export type TraceMapTarget = {
  code: string
  title: string
  status: 'published' | 'draft'
}

export function TracesView({
  onStart,
  hikes,
}: {
  onStart: () => void
  hikes: TraceMapTarget[]
}) {
  const [traces, setTraces] = useState<UserTraceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyTrace, setBusyTrace] = useState<string | null>(null)
  const [importTraceId, setImportTraceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    loadUserTraces()
      .then((items) => {
        if (!cancelled) {
          setTraces(items)
          setError(null)
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Lecture des traces impossible.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const totals = useMemo(
    () => ({
      distance: traces.reduce(
        (sum, trace) => sum + trace.stats.distanceMeters,
        0,
      ),
      gain: traces.reduce(
        (sum, trace) => sum + trace.stats.elevationGainMeters,
        0,
      ),
      points: traces.reduce((sum, trace) => sum + trace.stats.pointCount, 0),
    }),
    [traces],
  )

  const importOntoMap = (trace: UserTraceRecord, hike: TraceMapTarget) => {
    if (trace.points.length < 2) {
      setError('Cette trace ne contient pas assez de points GPS.')
      return
    }
    setPendingTraceImport({
      code: hike.code,
      name: trace.name,
      points: trace.points,
    })
    // Ouverture du Studio de la carte choisie : il consommera la trace en
    // attente au montage (ajoutee mais non sauvegardee, a relire puis Sauvegarder).
    window.location.assign(
      `/?mode=studio&code=${encodeURIComponent(hike.code)}` +
        `&title=${encodeURIComponent(hike.title)}`,
    )
  }

  const removeTrace = async (trace: UserTraceRecord) => {
    if (!window.confirm(`Supprimer "${trace.name}" de R2 ?`)) return
    setBusyTrace(trace.id)
    setError(null)
    try {
      await deleteUserTrace(trace.id)
      setTraces((current) => current.filter((item) => item.id !== trace.id))
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : 'Suppression impossible.',
      )
    } finally {
      setBusyTrace(null)
    }
  }

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="portal-kicker">Traces GPS</p>
          <h1>Mes traces</h1>
          <p>Enregistrements personnels stockes dans votre espace Relieo.</p>
        </div>
        <button className="portal-primary" type="button" onClick={onStart}>
          <Satellite size={18} /> Nouveau trace
        </button>
      </header>

      <section className="trace-summary-grid" aria-label="Resume des traces">
        <article className="summary-card featured">
          <span><Route size={19} /></span>
          <p>Traces</p>
          <strong>{traces.length}</strong>
          <small>{loading ? 'Lecture...' : 'stockees sur R2'}</small>
        </article>
        <article className="summary-card">
          <span><MapPin size={19} /></span>
          <p>Distance</p>
          <strong>{formatDistance(totals.distance)}</strong>
          <small>cumulee</small>
        </article>
        <article className="summary-card">
          <span><Mountain size={19} /></span>
          <p>Denivele +</p>
          <strong>{formatElevation(totals.gain)}</strong>
          <small>approximation GPS</small>
        </article>
        <article className="summary-card">
          <span><Crosshair size={19} /></span>
          <p>Points</p>
          <strong>{totals.points.toLocaleString('fr-FR')}</strong>
          <small>positions brutes</small>
        </article>
      </section>

      {error ? <p className="auth-error">{error}</p> : null}

      <section className="user-traces-section">
        <div className="section-heading">
          <div>
            <h2>Bibliotheque de traces</h2>
            <p>{loading ? 'Chargement...' : `${traces.length} trace${traces.length > 1 ? 's' : ''}`}</p>
          </div>
        </div>
        {loading ? (
          <div className="trace-empty-state">
            <span><Satellite size={25} /></span>
            <strong>Lecture des traces...</strong>
          </div>
        ) : traces.length === 0 ? (
          <div className="trace-empty-state">
            <span><Route size={25} /></span>
            <strong>Aucune trace pour l'instant</strong>
            <p>Lance un enregistrement depuis ton telephone pour creer la premiere.</p>
            <button className="portal-primary" type="button" onClick={onStart}>
              <Play size={17} /> Demarrer
            </button>
          </div>
        ) : (
          <div className="user-traces-list">
            {traces.map((trace) => (
              <article className="user-trace-card" key={trace.id}>
                <div className="user-trace-main">
                  <span className="user-trace-icon"><Route size={20} /></span>
                  <div>
                    <div className="user-trace-titleline">
                      <h3>{trace.name}</h3>
                      {traceStatusLabel(trace) ? (
                        <span className={`user-trace-status ${trace.status}`}>
                          {traceStatusLabel(trace)}
                        </span>
                      ) : null}
                    </div>
                    <p>
                      {formatDateTime(trace.startedAt)} - {formatDuration(trace.durationSeconds)}
                      {trace.autosavedAt && trace.status !== 'saved'
                        ? ` - auto ${formatDateTime(trace.autosavedAt)}`
                        : ''}
                    </p>
                  </div>
                </div>
                <dl className="user-trace-metrics">
                  <div><dt>Distance</dt><dd>{formatDistance(trace.stats.distanceMeters)}</dd></div>
                  <div><dt>D+</dt><dd>{formatElevation(trace.stats.elevationGainMeters)}</dd></div>
                  <div><dt>Points</dt><dd>{trace.stats.pointCount.toLocaleString('fr-FR')}</dd></div>
                </dl>
                <div className="user-trace-actions">
                  <button
                    type="button"
                    disabled={hikes.length === 0}
                    title={
                      hikes.length === 0
                        ? "Cree d'abord une carte pour y importer une trace."
                        : 'Importer cette trace sur une de vos cartes'
                    }
                    onClick={() =>
                      setImportTraceId((current) =>
                        current === trace.id ? null : trace.id,
                      )
                    }
                  >
                    <Map size={16} /> Importer
                  </button>
                  <button type="button" onClick={() => downloadTraceGpx(trace)}>
                    <Download size={16} /> GPX
                  </button>
                  <button
                    className="danger"
                    disabled={busyTrace === trace.id}
                    type="button"
                    onClick={() => void removeTrace(trace)}
                  >
                    <Trash2 size={16} /> Supprimer
                  </button>
                </div>
                {importTraceId === trace.id && hikes.length > 0 ? (
                  <div className="trace-import-picker">
                    <p>Importer sur quelle carte ?</p>
                    <div className="trace-import-options">
                      {hikes.map((hike) => (
                        <button
                          className="trace-import-option"
                          type="button"
                          key={hike.code}
                          onClick={() => importOntoMap(trace, hike)}
                        >
                          <Map size={15} />
                          <span>{hike.title}</span>
                          <small className={`trace-import-status ${hike.status}`}>
                            {hike.status === 'published' ? 'En ligne' : 'Brouillon'}
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export function TraceRecorderScreen({ onClose }: { onClose: () => void }) {
  const [localDraft, setLocalDraft] = useState<LocalTraceDraft | null>(
    () => readLocalTraceDraft(),
  )
  const [traceMeta, setTraceMeta] = useState<ActiveTraceMeta | null>(null)
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [points, setPoints] = useState<TrackPoint[]>([])
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  // États en écriture seule : ils pilotent l'enregistrement (wake lock, autosave)
  // mais ne sont plus affichés depuis le retrait du bandeau d'indicateurs.
  const [, setAccuracy] = useState<number | null>(null)
  const [, setWakeLockActive] = useState(false)
  const [, setWakeLockSupported] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signalWarning, setSignalWarning] = useState<string | null>(null)
  const [savedTrace, setSavedTrace] = useState<UserTraceRecord | null>(null)
  const [, setLastLocalSaveAt] = useState<string | null>(
    () => localDraft?.updatedAt ?? null,
  )
  const [lastCloudSaveAt, setLastCloudSaveAt] = useState<string | null>(
    () => localDraft?.autosavedAt ?? null,
  )
  const [, setCloudSaveBusy] = useState(false)
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)
  const traceMetaRef = useRef<ActiveTraceMeta | null>(null)
  const pointsRef = useRef<TrackPoint[]>([])
  const elapsedMsRef = useRef(0)
  const lastCloudSaveAtRef = useRef<string | null>(localDraft?.autosavedAt ?? null)
  const cloudSaveBusyRef = useRef(false)
  const pausedAtMsRef = useRef<number | null>(null)
  const ignoreNextPointRef = useRef(false)

  const stats = useMemo(() => computeTrailStats(points), [points])
  const elapsedSeconds = Math.round(elapsedMs / 1000)
  const averagePace = formatPace(elapsedSeconds, stats.distanceMeters)
  const exitLocked =
    status === 'recording' ||
    status === 'paused' ||
    status === 'saving' ||
    (status === 'idle' && Boolean(localDraft))

  useEffect(() => {
    traceMetaRef.current = traceMeta
  }, [traceMeta])

  useEffect(() => {
    pointsRef.current = points
  }, [points])

  useEffect(() => {
    elapsedMsRef.current = elapsedMs
  }, [elapsedMs])

  useEffect(() => {
    lastCloudSaveAtRef.current = lastCloudSaveAt
  }, [lastCloudSaveAt])

  useEffect(() => {
    document.documentElement.classList.add('tracker-scroll-active')
    document.body.classList.add('tracker-scroll-active')
    return () => {
      document.documentElement.classList.remove('tracker-scroll-active')
      document.body.classList.remove('tracker-scroll-active')
    }
  }, [])

  const releaseWakeLock = async () => {
    if (!wakeLockRef.current) return
    const current = wakeLockRef.current
    wakeLockRef.current = null
    try {
      await current.release()
    } catch {
      // Le navigateur peut deja l'avoir relache.
    } finally {
      setWakeLockActive(false)
    }
  }

  const requestWakeLock = async () => {
    const navigatorWithWakeLock = navigator as NavigatorWithWakeLock
    if (!navigatorWithWakeLock.wakeLock) {
      setWakeLockSupported(false)
      return
    }
    try {
      wakeLockRef.current = await navigatorWithWakeLock.wakeLock.request('screen')
      wakeLockRef.current.addEventListener?.('release', () => {
        setWakeLockActive(false)
      })
      setWakeLockSupported(true)
      setWakeLockActive(true)
    } catch {
      setWakeLockActive(false)
    }
  }

  const buildTraceRecord = useCallback((
    traceStatus: NonNullable<UserTraceRecord['status']>,
  ): UserTraceRecord | null => {
    const meta = traceMetaRef.current
    const currentPoints = pointsRef.current
    if (!meta || currentPoints.length < 2) return null
    const now = new Date().toISOString()
    return {
      id: meta.id,
      name: meta.name,
      status: traceStatus,
      createdAt: meta.createdAt,
      updatedAt: now,
      autosavedAt: traceStatus === 'saved' ? undefined : now,
      startedAt: meta.startedAt,
      endedAt: now,
      durationSeconds: Math.max(
        1,
        Math.round(((pausedAtMsRef.current ?? Date.now()) - meta.startedAtMs) / 1000),
      ),
      points: currentPoints,
      stats: computeTrailStats(currentPoints),
    }
  }, [])

  const persistLocalDraft = useCallback((
    meta = traceMetaRef.current,
    currentPoints = pointsRef.current,
  ) => {
    if (!meta) return
    const now = new Date().toISOString()
    const draft: LocalTraceDraft = {
      ...meta,
      updatedAt: now,
      autosavedAt: lastCloudSaveAtRef.current ?? undefined,
      elapsedMs: Math.max(0, (pausedAtMsRef.current ?? Date.now()) - meta.startedAtMs),
      points: currentPoints,
    }
    writeLocalTraceDraft(draft)
    setLocalDraft(draft)
    setLastLocalSaveAt(now)
  }, [])

  const persistCloudTrace = useCallback(async (
    traceStatus: NonNullable<UserTraceRecord['status']>,
  ): Promise<UserTraceRecord | null> => {
    if (cloudSaveBusyRef.current) return null
    const record = buildTraceRecord(traceStatus)
    if (!record) return null

    cloudSaveBusyRef.current = true
    setCloudSaveBusy(true)
    try {
      const saved = await saveUserTrace(record)
      const cloudSavedAt = saved.autosavedAt ?? saved.updatedAt
      setLastCloudSaveAt(cloudSavedAt)
      lastCloudSaveAtRef.current = cloudSavedAt
      if (traceStatus !== 'saved') {
        persistLocalDraft(traceMetaRef.current, pointsRef.current)
      }
      return saved
    } catch (saveError) {
      if (traceStatus === 'saved') throw saveError
      setSignalWarning('Autosave R2 impossible pour le moment, copie locale OK.')
      return null
    } finally {
      cloudSaveBusyRef.current = false
      setCloudSaveBusy(false)
    }
  }, [buildTraceRecord, persistLocalDraft])

  const maybeAutosaveCloud = useCallback(() => {
    if (pointsRef.current.length < 2) return
    const previous = lastCloudSaveAtRef.current
      ? Date.parse(lastCloudSaveAtRef.current)
      : 0
    if (Date.now() - previous < CLOUD_AUTOSAVE_INTERVAL_MS) return
    void persistCloudTrace('recording')
  }, [persistCloudTrace])

  useEffect(() => {
    return () => {
      void releaseWakeLock()
    }
  }, [])

  useEffect(() => {
    if (status !== 'recording' && status !== 'paused') return undefined
    const onPageHide = () => persistLocalDraft()
    window.addEventListener('pagehide', onPageHide)
    document.addEventListener('visibilitychange', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onPageHide)
    }
  }, [persistLocalDraft, status])

  useEffect(() => {
    if (!exitLocked) return undefined
    const keepTrackerOpen = () => {
      persistLocalDraft()
      if (window.location.pathname !== '/tracker') {
        window.history.pushState({}, '', '/tracker')
        window.dispatchEvent(new PopStateEvent('popstate'))
        setSignalWarning('Arrete ou supprime la trace avant de quitter cet ecran.')
      }
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      persistLocalDraft()
      event.preventDefault()
      event.returnValue = ''
    }

    keepTrackerOpen()
    window.addEventListener('popstate', keepTrackerOpen)
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => {
      window.removeEventListener('popstate', keepTrackerOpen)
      window.removeEventListener('beforeunload', warnBeforeUnload)
    }
  }, [exitLocked, persistLocalDraft])

  useEffect(() => {
    if (status !== 'recording') return undefined
    const interval = window.setInterval(() => {
      void persistCloudTrace('recording')
    }, CLOUD_AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [persistCloudTrace, status])

  useEffect(() => {
    if (status !== 'recording' || !startedAtMs) return undefined
    const tick = () => setElapsedMs(Date.now() - startedAtMs)
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [startedAtMs, status])

  useEffect(() => {
    if (status !== 'recording') return undefined
    if (!navigator.geolocation) return undefined

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const nextPoint = pointFromPosition(position)
        const nextAccuracy = Math.round(position.coords.accuracy)
        setAccuracy(nextAccuracy)
        setError(null)
        // Garde anti-parasite : on jette le point qui arrive pile au moment de
        // la pause, ainsi que le premier point au redemarrage (souvent perime).
        if (ignoreNextPointRef.current) {
          ignoreNextPointRef.current = false
          return
        }
        const currentPoints = pointsRef.current
        const previous = currentPoints[currentPoints.length - 1]

        if (
          previous &&
          nextAccuracy > MAX_ACCEPTED_ACCURACY_METERS
        ) {
          setSignalWarning(`Signal faible: point ignore (${nextAccuracy} m).`)
          return
        }

        if (previous) {
          const movedMeters = distanceBetween(previous, nextPoint)
          const previousTime = previous.time ? Date.parse(previous.time) : 0
          const nextTime = nextPoint.time ? Date.parse(nextPoint.time) : 0
          const elapsedSecondsBetweenPoints = Math.max(
            1,
            (nextTime - previousTime) / 1000,
          )
          if (movedMeters < 4 && nextTime - previousTime < 5000) {
            return
          }
          if (
            movedMeters / elapsedSecondsBetweenPoints >
              MAX_REASONABLE_SPEED_METERS_PER_SECOND &&
            nextAccuracy > 30
          ) {
            setSignalWarning('Saut GPS ignore: position trop incoherente.')
            return
          }
        }

        const nextPoints = [...currentPoints, nextPoint]
        pointsRef.current = nextPoints
        setPoints(nextPoints)
        setSignalWarning(null)
        persistLocalDraft(traceMetaRef.current, nextPoints)
        maybeAutosaveCloud()
      },
      (positionError) => {
        setError(positionErrorMessage(positionError))
        if (pointsRef.current.length >= 2) {
          void persistCloudTrace('interrupted')
        }
        setStatus('idle')
        void releaseWakeLock()
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 15000,
      },
    )

    return () => navigator.geolocation.clearWatch(watchId)
  }, [maybeAutosaveCloud, persistCloudTrace, persistLocalDraft, status])

  const startRecording = () => {
    if (!navigator.geolocation) {
      setError('GPS indisponible sur cet appareil.')
      return
    }
    const now = new Date()
    const meta: ActiveTraceMeta = {
      id: traceIdFromDate(now),
      name: defaultTraceName(now),
      createdAt: now.toISOString(),
      startedAt: now.toISOString(),
      startedAtMs: Date.now(),
    }
    traceMetaRef.current = meta
    pausedAtMsRef.current = null
    ignoreNextPointRef.current = false
    setPoints([])
    pointsRef.current = []
    setTraceMeta(meta)
    setSavedTrace(null)
    setError(null)
    setSignalWarning(null)
    setStartedAtMs(meta.startedAtMs)
    setElapsedMs(0)
    setAccuracy(null)
    setLastCloudSaveAt(null)
    lastCloudSaveAtRef.current = null
    setStatus('recording')
    persistLocalDraft(meta, [])
    void requestWakeLock()
  }

  const resumeLocalDraft = () => {
    if (!localDraft || !navigator.geolocation) return
    const elapsedSinceStart = Math.max(
      localDraft.elapsedMs,
      Date.now() - Date.parse(localDraft.startedAt),
    )
    const meta: ActiveTraceMeta = {
      id: localDraft.id,
      name: localDraft.name,
      createdAt: localDraft.createdAt,
      startedAt: localDraft.startedAt,
      startedAtMs: Date.now() - elapsedSinceStart,
    }
    traceMetaRef.current = meta
    pausedAtMsRef.current = null
    ignoreNextPointRef.current = false
    pointsRef.current = localDraft.points
    setTraceMeta(meta)
    setPoints(localDraft.points)
    setStartedAtMs(meta.startedAtMs)
    setElapsedMs(elapsedSinceStart)
    setLastCloudSaveAt(localDraft.autosavedAt ?? null)
    lastCloudSaveAtRef.current = localDraft.autosavedAt ?? null
    setSavedTrace(null)
    setError(null)
    setSignalWarning(null)
    setStatus('recording')
    persistLocalDraft(meta, localDraft.points)
    void requestWakeLock()
  }

  const pauseRecording = () => {
    if (status !== 'recording') return
    const pausedAt = Date.now()
    pausedAtMsRef.current = pausedAt
    // Un point GPS qui arriverait pile a l'instant de la pause est ignore.
    ignoreNextPointRef.current = true
    const meta = traceMetaRef.current
    if (meta) {
      setElapsedMs(Math.max(0, pausedAt - meta.startedAtMs))
    }
    setStatus('paused')
    // On securise la trace : copie locale + autosave R2 au moment de la pause.
    persistLocalDraft()
    void persistCloudTrace('recording')
    void releaseWakeLock()
  }

  const resumeRecording = () => {
    if (status !== 'paused') return
    const pausedAt = pausedAtMsRef.current
    const meta = traceMetaRef.current
    if (pausedAt != null && meta) {
      // On decale le depart de la duree de la pause : le temps telephone pose
      // ne compte ni dans le timer ni dans la duree finale enregistree.
      const pausedDuration = Math.max(0, Date.now() - pausedAt)
      const resumedMeta: ActiveTraceMeta = {
        ...meta,
        startedAtMs: meta.startedAtMs + pausedDuration,
      }
      traceMetaRef.current = resumedMeta
      setTraceMeta(resumedMeta)
      setStartedAtMs(resumedMeta.startedAtMs)
    }
    pausedAtMsRef.current = null
    // Le premier point au redemarrage est souvent perime : on le laisse tomber.
    ignoreNextPointRef.current = true
    setError(null)
    setSignalWarning(null)
    setStatus('recording')
    void requestWakeLock()
  }

  const discardLocalDraft = () => {
    clearLocalTraceDraft()
    setLocalDraft(null)
    setLastLocalSaveAt(null)
    setLastCloudSaveAt(null)
    lastCloudSaveAtRef.current = null
  }

  const stopRecording = async () => {
    if (points.length < 2) {
      setError('Attends au moins deux points GPS avant de sauvegarder.')
      return
    }
    setStatus('saving')
    setError(null)
    await releaseWakeLock()
    try {
      const saved = await persistCloudTrace('saved')
      if (!saved) throw new Error('Trace non enregistree.')
      setSavedTrace(saved)
      setPoints(saved.points)
      pointsRef.current = saved.points
      clearLocalTraceDraft()
      setLocalDraft(null)
      setLastLocalSaveAt(null)
      setStatus('saved')
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'Sauvegarde de la trace impossible.',
      )
      setStatus('idle')
    }
  }

  const statusLabel =
    status === 'recording'
      ? 'En cours'
      : status === 'paused'
        ? 'En pause'
        : status === 'saving'
          ? 'Sauvegarde'
          : status === 'saved'
            ? 'Sauvegardee'
            : 'Pret'

  return (
    <main className="trace-recorder-screen">
      <section className="trace-recorder-panel">
        <header className="trace-recorder-head">
          <button
            className="trace-icon-button"
            disabled={exitLocked}
            title={exitLocked ? 'Arrete la trace avant de quitter.' : 'Retour'}
            type="button"
            onClick={onClose}
          >
            <ArrowLeft size={19} />
          </button>
          <div>
            <p className="portal-kicker">Trace GPS</p>
            <h1>{traceMeta?.name ?? 'Enregistrement'}</h1>
          </div>
          <span className={`trace-status-pill ${status}`}>{statusLabel}</span>
        </header>

        {status === 'idle' && localDraft ? (
          <div className="trace-draft-resume">
            <span><HardDrive size={18} /></span>
            <div>
              <strong>Trace locale retrouvee</strong>
              <p>
                {localDraft.points.length} point{localDraft.points.length > 1 ? 's' : ''} -
                {' '}derniere copie {formatDateTime(localDraft.updatedAt)}
              </p>
            </div>
            <button className="portal-primary" type="button" onClick={resumeLocalDraft}>
              Reprendre
            </button>
            <button className="portal-secondary" type="button" onClick={discardLocalDraft}>
              Supprimer
            </button>
          </div>
        ) : null}

        <section className="trace-sport-dashboard">
          <div className="trace-duration-block">
            <span>Duree</span>
            <strong>{formatTimer(elapsedSeconds)}</strong>
          </div>
          <dl className="trace-sport-metrics">
            <div>
              <dt>Distance</dt>
              <dd>{formatDistance(stats.distanceMeters)}</dd>
            </div>
            <div>
              <dt>D+</dt>
              <dd>{formatElevation(stats.elevationGainMeters)}</dd>
            </div>
            <div>
              <dt>Allure moy.</dt>
              <dd>{averagePace}<small>/km</small></dd>
            </div>
          </dl>
          {status === 'idle' && !localDraft ? (
            <button
              className="trace-start-inline"
              type="button"
              onClick={startRecording}
            >
              <Play size={18} /> Demarrer le trace
            </button>
          ) : null}
          <TracePreview points={points} />
        </section>

        {error ? <p className="auth-error">{error}</p> : null}
        {signalWarning ? <p className="trace-warning">{signalWarning}</p> : null}
        {savedTrace ? (
          <p className="trace-success"><Check size={17} /> Trace enregistree dans Relieo.</p>
        ) : null}

        <div className="trace-recorder-actions">
          {status === 'recording' || status === 'paused' ? (
            <div className="trace-recorder-controls">
              <button
                className={`trace-pause-button${status === 'paused' ? ' is-paused' : ''}`}
                type="button"
                onClick={status === 'paused' ? resumeRecording : pauseRecording}
              >
                {status === 'paused' ? (
                  <><Play size={18} /> Reprendre</>
                ) : (
                  <><Pause size={18} /> Pause</>
                )}
              </button>
              <button className="trace-stop-button" type="button" onClick={() => void stopRecording()}>
                <Square size={18} /> Arreter et sauvegarder
              </button>
            </div>
          ) : (
            <button
              className="portal-primary"
              disabled={status === 'saving' || Boolean(localDraft)}
              type="button"
              onClick={startRecording}
            >
              <Play size={18} /> {status === 'saved' ? 'Nouveau trace' : 'Demarrer'}
            </button>
          )}
          {status === 'saved' ? (
            <button className="portal-secondary" type="button" onClick={onClose}>
              Voir mes traces
            </button>
          ) : null}
        </div>
      </section>
    </main>
  )
}
