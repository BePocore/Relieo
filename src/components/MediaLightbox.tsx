import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { LightboxMedia } from '../App'

type MediaLightboxProps = {
  media: LightboxMedia
  onClose: () => void
}

export function MediaLightbox({ media, onClose }: MediaLightboxProps) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

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

      <div className="lightbox-stage" onClick={(event) => event.stopPropagation()}>
        {media.kind === 'video' ? (
          <video
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
        {media.title ? (
          <p className="lightbox-caption">{media.title}</p>
        ) : null}
      </div>
    </div>
  )
}
