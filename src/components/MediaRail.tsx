import { Camera, Play, Scan } from 'lucide-react'
import { resolvePointMedia } from '../lib/media'
import type { ImportedMedia, TrailPoint } from '../types'

type MediaRailProps = {
  points: TrailPoint[]
  mediaLibrary: ImportedMedia[]
  selectedPoint: TrailPoint | null
  onSelectPoint: (point: TrailPoint) => void
}

export function MediaRail({
  points,
  mediaLibrary,
  selectedPoint,
  onSelectPoint,
}: MediaRailProps) {
  if (points.length === 0) return null

  return (
    <div className="media-rail" aria-label="Médias du parcours">
      <div className="media-rail-track">
        {points.map((point) => {
          const media = resolvePointMedia(point, mediaLibrary)
          const isSelected = selectedPoint?.id === point.id

          return (
            <button
              aria-label={`Voir ${point.title}`}
              aria-pressed={isSelected}
              className={isSelected ? 'media-tile active' : 'media-tile'}
              key={point.id ?? point.title}
              type="button"
              onClick={() => onSelectPoint(point)}
            >
              <span className="media-tile-visual">
                {media?.kind === 'image' ? (
                  <img
                    src={media.src}
                    alt=""
                    decoding="async"
                    loading="lazy"
                    fetchPriority="low"
                  />
                ) : (
                  <span className={`media-tile-fallback type-${point.type}`}>
                    {point.type === 'video' ? (
                      <Play aria-hidden="true" size={20} fill="currentColor" />
                    ) : point.type === '360' ? (
                      <Scan aria-hidden="true" size={21} />
                    ) : (
                      <Camera aria-hidden="true" size={20} />
                    )}
                  </span>
                )}
                <span className={`media-kind-badge type-${point.type}`}>
                  {point.type === '360' ? '360°' : point.type}
                </span>
              </span>
              <span className="media-tile-title">{point.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
