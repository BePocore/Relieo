import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Clock,
  Crosshair,
  Download,
  MapPin,
  Mountain,
  Play,
  Route,
  Satellite,
  Square,
  Trash2,
  Zap,
} from 'lucide-react'
import type { TrackPoint } from '../types'
import { computeTrailStats, distanceBetween } from '../lib/geo'
import {
  deleteUserTrace,
  downloadTraceGpx,
  loadUserTraces,
  saveUserTrace,
  type UserTraceRecord,
} from './userTraces'

type RecorderStatus = 'idle' | 'recording' | 'saving' | 'saved'

type WakeLockSentinelLike = {
  release: () => Promise<void>
  addEventListener?: (type: 'release', listener: () => void) => void
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>
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

export function TracesView({ onStart }: { onStart: () => void }) {
  const [traces, setTraces] = useState<UserTraceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyTrace, setBusyTrace] = useState<string | null>(null)
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
                    <h3>{trace.name}</h3>
                    <p>{formatDateTime(trace.startedAt)} - {formatDuration(trace.durationSeconds)}</p>
                  </div>
                </div>
                <dl className="user-trace-metrics">
                  <div><dt>Distance</dt><dd>{formatDistance(trace.stats.distanceMeters)}</dd></div>
                  <div><dt>D+</dt><dd>{formatElevation(trace.stats.elevationGainMeters)}</dd></div>
                  <div><dt>Points</dt><dd>{trace.stats.pointCount.toLocaleString('fr-FR')}</dd></div>
                </dl>
                <div className="user-trace-actions">
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
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

export function TraceRecorderScreen({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [points, setPoints] = useState<TrackPoint[]>([])
  const [startedAtIso, setStartedAtIso] = useState<string | null>(null)
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [accuracy, setAccuracy] = useState<number | null>(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [wakeLockSupported, setWakeLockSupported] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savedTrace, setSavedTrace] = useState<UserTraceRecord | null>(null)
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null)

  const stats = useMemo(() => computeTrailStats(points), [points])
  const elapsedSeconds = Math.round(elapsedMs / 1000)
  const lastPoint = points[points.length - 1]

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

  useEffect(() => {
    return () => {
      void releaseWakeLock()
    }
  }, [])

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
        setAccuracy(Math.round(position.coords.accuracy))
        setError(null)
        setPoints((current) => {
          const previous = current[current.length - 1]
          if (previous) {
            const movedMeters = distanceBetween(previous, nextPoint)
            const previousTime = previous.time ? Date.parse(previous.time) : 0
            const nextTime = nextPoint.time ? Date.parse(nextPoint.time) : 0
            if (movedMeters < 4 && nextTime - previousTime < 5000) {
              return current
            }
          }
          return [...current, nextPoint]
        })
      },
      (positionError) => {
        setError(positionErrorMessage(positionError))
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
  }, [status])

  const startRecording = () => {
    if (!navigator.geolocation) {
      setError('GPS indisponible sur cet appareil.')
      return
    }
    const now = new Date()
    setPoints([])
    setSavedTrace(null)
    setError(null)
    setStartedAtIso(now.toISOString())
    setStartedAtMs(Date.now())
    setElapsedMs(0)
    setAccuracy(null)
    setStatus('recording')
    void requestWakeLock()
  }

  const stopRecording = async () => {
    if (points.length < 2) {
      setError('Attends au moins deux points GPS avant de sauvegarder.')
      return
    }
    const now = new Date()
    const trace: UserTraceRecord = {
      id: traceIdFromDate(now),
      name: defaultTraceName(now),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: startedAtIso ?? points[0].time ?? now.toISOString(),
      endedAt: now.toISOString(),
      durationSeconds: Math.max(
        1,
        Math.round((startedAtMs ? Date.now() - startedAtMs : elapsedMs) / 1000),
      ),
      points,
      stats,
    }
    setStatus('saving')
    setError(null)
    await releaseWakeLock()
    try {
      const saved = await saveUserTrace(trace)
      setSavedTrace(saved)
      setPoints(saved.points)
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
      : status === 'saving'
        ? 'Sauvegarde'
        : status === 'saved'
          ? 'Sauvegardee'
          : 'Pret'

  return (
    <main className="trace-recorder-screen">
      <section className="trace-recorder-panel">
        <header className="trace-recorder-head">
          <button className="trace-icon-button" type="button" onClick={onClose}>
            <ArrowLeft size={19} />
          </button>
          <div>
            <p className="portal-kicker">Trace GPS</p>
            <h1>Enregistrement</h1>
          </div>
          <span className={`trace-status-pill ${status}`}>{statusLabel}</span>
        </header>

        <div className="trace-live-card">
          <span className="trace-live-icon"><Satellite size={28} /></span>
          <strong>{formatDistance(stats.distanceMeters)}</strong>
          <p>{status === 'recording' ? 'Signal actif' : 'Distance tracee'}</p>
        </div>

        <section className="trace-recorder-stats" aria-label="Mesures">
          <article>
            <Clock size={18} />
            <span>Temps</span>
            <strong>{formatDuration(elapsedSeconds)}</strong>
          </article>
          <article>
            <Mountain size={18} />
            <span>D+</span>
            <strong>{formatElevation(stats.elevationGainMeters)}</strong>
          </article>
          <article>
            <Crosshair size={18} />
            <span>Points</span>
            <strong>{stats.pointCount}</strong>
          </article>
        </section>

        <div className="trace-recorder-signal">
          <span><MapPin size={16} /> Precision {accuracy ? `${accuracy} m` : '-'}</span>
          <span><Zap size={16} /> {wakeLockActive ? 'Ecran actif' : wakeLockSupported ? 'Veille possible' : 'Wake lock absent'}</span>
          <span><Route size={16} /> {lastPoint ? `${lastPoint.lat.toFixed(5)}, ${lastPoint.lng.toFixed(5)}` : 'Position en attente'}</span>
        </div>

        {error ? <p className="auth-error">{error}</p> : null}
        {savedTrace ? (
          <p className="trace-success"><Check size={17} /> Trace enregistree dans Relieo.</p>
        ) : null}

        <div className="trace-recorder-actions">
          {status === 'recording' ? (
            <button className="trace-stop-button" type="button" onClick={() => void stopRecording()}>
              <Square size={18} /> Arreter et sauvegarder
            </button>
          ) : (
            <button
              className="portal-primary"
              disabled={status === 'saving'}
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
