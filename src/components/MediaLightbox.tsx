import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
} from 'react'
import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react'
import { Panorama360 } from './Panorama360'
import type { LightboxMedia } from '../App'

type MediaLightboxProps = {
  items: LightboxMedia[]
  startIndex?: number
  // Diaporama : clé localStorage où mémoriser la position pour la reprise.
  persistKey?: string
  onClose: () => void
}

// Durées d'affichage en lecture auto (les vidéos, elles, jouent jusqu'à leur
// fin avant d'avancer, pour laisser parler les mini-vlogs).
const PHOTO_MS = 4200
const BREAK_MS = 2600

export function MediaLightbox({
  items,
  startIndex = 0,
  persistKey,
  onClose,
}: MediaLightboxProps) {
  const [index, setIndex] = useState(startIndex)
  const [playing, setPlaying] = useState(false)
  const count = items.length
  const safeIndex = Math.min(index, count - 1)
  const media = items[safeIndex]

  // ── Reprise du diaporama ────────────────────────────────────────────────
  // On mémorise la position + l'heure à chaque changement de vue (couvre le
  // rechargement de page), et une dernière fois au démontage avec une heure
  // fraîche (couvre la fermeture explicite, pour un vrai « quitté il y a X »).
  const indexRef = useRef(safeIndex)
  useEffect(() => {
    indexRef.current = safeIndex
    if (!persistKey) return
    try {
      window.localStorage.setItem(
        persistKey,
        JSON.stringify({ index: safeIndex, ts: Date.now() }),
      )
    } catch {
      /* localStorage indisponible */
    }
  }, [persistKey, safeIndex])
  useEffect(() => {
    if (!persistKey) return
    return () => {
      try {
        window.localStorage.setItem(
          persistKey,
          JSON.stringify({ index: indexRef.current, ts: Date.now() }),
        )
      } catch {
        /* localStorage indisponible */
      }
    }
  }, [persistKey])

  // ── Seek : clic / glissement n'importe où sur la barre de défilement ─────
  const progressRef = useRef<HTMLDivElement>(null)
  const seekingRef = useRef(false)
  const seekToClientX = (clientX: number) => {
    const el = progressRef.current
    if (!el || count <= 1) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const fraction = (clientX - rect.left) / rect.width
    const target = Math.max(0, Math.min(count - 1, Math.floor(fraction * count)))
    setIndex(target)
  }
  const handleSeekDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (count <= 1) return
    seekingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    seekToClientX(event.clientX)
  }
  const handleSeekMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!seekingRef.current) return
    seekToClientX(event.clientX)
  }
  const handleSeekUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    seekingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const go = (delta: number) =>
    setIndex((current) => (current + delta + count) % count)

  const hasBreaks = useMemo(
    () => items.some((item) => item.kind === 'day-break'),
    [items],
  )

  // Segments de progression : un par jour (de sa carte de transition jusqu'à
  // la suivante), largeur proportionnelle au nombre de slides, teinté du jour.
  const segments = useMemo(() => {
    if (!hasBreaks) return []
    const segs: Array<{ color: string; start: number; length: number }> = []
    items.forEach((item, i) => {
      if (item.kind === 'day-break') {
        segs.push({
          color: item.dayBreak?.color ?? '#4fd1a1',
          start: i,
          length: 1,
        })
      } else if (segs.length > 0) {
        segs[segs.length - 1].length += 1
      }
    })
    return segs
  }, [items, hasBreaks])

  // Swipe horizontal (tactile) pour passer à la slide suivante / précédente.
  const [touchStartX, setTouchStartX] = useState<number | null>(null)
  const handleTouchStart = (event: ReactTouchEvent) => {
    setTouchStartX(event.changedTouches[0]?.clientX ?? null)
  }
  const handleTouchEnd = (event: ReactTouchEvent) => {
    if (touchStartX === null || count <= 1) return
    const deltaX = (event.changedTouches[0]?.clientX ?? touchStartX) - touchStartX
    if (Math.abs(deltaX) > 45) go(deltaX < 0 ? 1 : -1)
    setTouchStartX(null)
  }

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && count > 1) go(1)
      else if (event.key === 'ArrowLeft' && count > 1) go(-1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, count])

  // Lecture auto : les vidéos avancent sur leur fin (onEnded), le reste sur
  // une minuterie. Boucle en fin de diaporama.
  useEffect(() => {
    if (!playing || count <= 1) return
    const current = items[safeIndex]
    if (current?.kind === 'video') return
    const delay = current?.kind === 'day-break' ? BREAK_MS : PHOTO_MS
    const timer = window.setTimeout(() => {
      setIndex((c) => (c + 1) % count)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [playing, safeIndex, count, items])

  if (!media) return null

  return (
    <div
      className={count > 1 ? 'lightbox has-controls' : 'lightbox'}
      role="dialog"
      aria-modal="true"
      aria-label={media.title ?? 'Média en grand'}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <button
        className="lightbox-close"
        type="button"
        aria-label="Fermer"
        title="Fermer"
        onClick={onClose}
      >
        <X aria-hidden="true" size={22} />
      </button>

      {count > 1 ? (
        <button
          className="lightbox-nav prev"
          type="button"
          aria-label="Précédent"
          onClick={(event) => {
            event.stopPropagation()
            go(-1)
          }}
        >
          <ChevronLeft aria-hidden="true" size={26} />
        </button>
      ) : null}

      <div className="lightbox-stage" onClick={(event) => event.stopPropagation()}>
        {media.kind === 'day-break' ? (
          <div
            className="lightbox-daybreak"
            style={{ ['--day' as string]: media.dayBreak?.color ?? '#4fd1a1' }}
          >
            <span className="db-intro">{media.dayBreak?.intro}</span>
            <span className="db-day">{media.dayBreak?.label}</span>
            <span className="db-date">{media.dayBreak?.dateLabel}</span>
            <span className="db-line" />
            <div className="db-stats">
              {media.dayBreak?.distanceLabel ? (
                <div>
                  <b>{media.dayBreak.distanceLabel}</b>
                  <span>distance</span>
                </div>
              ) : null}
              {media.dayBreak?.gainLabel ? (
                <div>
                  <b>+{media.dayBreak.gainLabel}</b>
                  <span>dénivelé</span>
                </div>
              ) : null}
              <div>
                <b>{media.dayBreak?.mediaCount ?? 0}</b>
                <span>médias</span>
              </div>
            </div>
          </div>
        ) : media.kind === '360' ? (
          <Panorama360
            key={media.src}
            src={media.src}
            className="lightbox-media lightbox-360"
          />
        ) : media.kind === 'video' ? (
          <video
            key={media.src}
            className="lightbox-media"
            src={media.src}
            controls
            autoPlay
            playsInline
            onEnded={() => {
              if (playing && count > 1) go(1)
            }}
          />
        ) : (
          <img
            className="lightbox-media"
            src={media.src}
            alt={media.title ?? ''}
            decoding="async"
          />
        )}
        {media.kind !== 'day-break' ? (
          <p className="lightbox-caption">
            {media.title ? <span>{media.title}</span> : null}
            {count > 1 ? (
              <small>
                {safeIndex + 1} / {count}
              </small>
            ) : null}
          </p>
        ) : null}
      </div>

      {count > 1 ? (
        <button
          className="lightbox-nav next"
          type="button"
          aria-label="Suivant"
          onClick={(event) => {
            event.stopPropagation()
            go(1)
          }}
        >
          <ChevronRight aria-hidden="true" size={26} />
        </button>
      ) : null}

      {count > 1 ? (
        <div
          className="lightbox-controls"
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="lightbox-play"
            aria-label={playing ? 'Pause' : 'Lecture automatique'}
            title={playing ? 'Pause' : 'Lecture automatique'}
            onClick={() => setPlaying((current) => !current)}
          >
            {playing ? (
              <Pause aria-hidden="true" size={18} />
            ) : (
              <Play aria-hidden="true" size={18} />
            )}
          </button>
          <div
            className="lightbox-progress"
            ref={progressRef}
            role="slider"
            aria-label="Position dans le diaporama"
            aria-valuemin={1}
            aria-valuemax={count}
            aria-valuenow={safeIndex + 1}
            tabIndex={0}
            onPointerDown={handleSeekDown}
            onPointerMove={handleSeekMove}
            onPointerUp={handleSeekUp}
            onPointerCancel={handleSeekUp}
          >
            {hasBreaks ? (
              segments.map((seg) => {
                const done = Math.max(
                  0,
                  Math.min(seg.length, safeIndex - seg.start + 1),
                )
                return (
                  <span
                    key={seg.start}
                    className="lb-seg"
                    style={{ flexGrow: seg.length }}
                  >
                    <b
                      style={{
                        width: `${(done / seg.length) * 100}%`,
                        background: seg.color,
                      }}
                    />
                  </span>
                )
              })
            ) : (
              <span className="lb-seg" style={{ flexGrow: 1 }}>
                <b
                  style={{
                    width: `${((safeIndex + 1) / count) * 100}%`,
                    background: '#4fd1a1',
                  }}
                />
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
