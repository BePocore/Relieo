import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { LightboxMedia } from '../App'

type MediaLightboxProps = {
  items: LightboxMedia[]
  startIndex?: number
  onClose: () => void
}

export function MediaLightbox({
  items,
  startIndex = 0,
  onClose,
}: MediaLightboxProps) {
  const [index, setIndex] = useState(startIndex)
  const count = items.length
  const media = items[Math.min(index, count - 1)]

  const go = (delta: number) =>
    setIndex((current) => (current + delta + count) % count)

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

  if (!media) return null

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={media.title ?? 'Média en grand'}
      onClick={onClose}
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
        {media.kind === 'video' ? (
          <video
            key={media.src}
            className="lightbox-media"
            src={media.src}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <img
            className="lightbox-media"
            src={media.src}
            alt={media.title ?? ''}
            decoding="async"
          />
        )}
        <p className="lightbox-caption">
          {media.title ? <span>{media.title}</span> : null}
          {count > 1 ? (
            <small>
              {(index % count) + 1} / {count}
            </small>
          ) : null}
        </p>
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
    </div>
  )
}
