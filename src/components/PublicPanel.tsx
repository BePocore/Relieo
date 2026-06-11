import { Mountain, Timer } from 'lucide-react'
import { ElevationProfile } from './ElevationProfile'
import { PointDetail } from './PointDetail'
import { PointTypeIcon } from './PointTypeIcon'
import { pointTypeLabels } from '../lib/pointMeta'
import { resolvePointMedia } from '../lib/media'
import type { ImportedMedia, TrackPoint, TrailPoint, TrailStats } from '../types'

type PublicPanelProps = {
  selectedPoint: TrailPoint | null
  points: TrailPoint[]
  track: TrackPoint[]
  stats: TrailStats
  mediaLibrary: ImportedMedia[]
  hikingTime: string | null
  onSelectPoint: (point: TrailPoint) => void
  onClose: () => void
}

export function PublicPanel({
  selectedPoint,
  points,
  track,
  stats,
  mediaLibrary,
  hikingTime,
  onSelectPoint,
  onClose,
}: PublicPanelProps) {
  if (selectedPoint) {
    return (
      <PointDetail
        point={selectedPoint}
        mediaLibrary={mediaLibrary}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Parcours</p>
          <h2>Points de passage</h2>
        </div>
        <Mountain aria-hidden="true" size={22} />
      </div>

      {hikingTime ? (
        <p className="duration-chip">
          <Timer aria-hidden="true" size={15} />
          <span>Durée estimée · {hikingTime}</span>
        </p>
      ) : null}

      <ElevationProfile track={track} stats={stats} />

      <div className="point-list">
        {points.length === 0 ? (
          <div className="empty-state">Aucun point pour le moment.</div>
        ) : null}

        {points.map((point) => {
          const media = resolvePointMedia(point, mediaLibrary)

          return (
            <button
              className="point-row"
              key={point.id ?? point.title}
              type="button"
              onClick={() => onSelectPoint(point)}
            >
              <span className="point-row-visual">
                {media?.kind === 'image' ? (
                  <img
                    src={media.src}
                    alt=""
                    decoding="async"
                    loading="lazy"
                    fetchPriority="low"
                  />
                ) : (
                  <span className={`type-dot type-${point.type}`}>
                    <PointTypeIcon type={point.type} />
                  </span>
                )}
              </span>
              <span className="point-row-copy">
                <strong>{point.title}</strong>
                <small>{pointTypeLabels[point.type]}</small>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
