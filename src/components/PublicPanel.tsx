import { useState } from 'react'
import { ChevronRight, Mountain, Play } from 'lucide-react'
import { ElevationProfile } from './ElevationProfile'
import { DayElevationSparkline } from './DayElevationSparkline'
import { PointDetail } from './PointDetail'
import { PointTypeIcon } from './PointTypeIcon'
import { resolvePointMedia } from '../lib/media'
import {
  computeDayStats,
  dayTraces,
  isMediaPoint,
  type DayPlan,
  type TripDay,
} from '../lib/days'
import { formatDistance, formatGain } from '../lib/format'
import type { ImportedMedia, Trace, TrailPoint, TrailStats } from '../types'
import type { LightboxMedia } from '../App'

type PublicPanelProps = {
  selectedPoint: TrailPoint | null
  points: TrailPoint[]
  traces: Trace[]
  stats: TrailStats
  mediaLibrary: ImportedMedia[]
  dayPlan: DayPlan
  activeDayKey: string | null
  onSelectDay: (key: string | null) => void
  onSelectPoint: (point: TrailPoint) => void
  onShowMedia: (media: LightboxMedia) => void
  onClose: () => void
}

export function PublicPanel({
  selectedPoint,
  points,
  traces,
  stats,
  mediaLibrary,
  dayPlan,
  activeDayKey,
  onSelectDay,
  onSelectPoint,
  onShowMedia,
  onClose,
}: PublicPanelProps) {
  // Section « Non datés » : repli local, sans lien avec le filtre de la carte.
  const [undatedOpen, setUndatedOpen] = useState(false)

  if (selectedPoint) {
    return (
      <PointDetail
        point={selectedPoint}
        mediaLibrary={mediaLibrary}
        onShowMedia={onShowMedia}
        onClose={onClose}
      />
    )
  }

  // Pellicule horizontale des médias : chaque vignette ouvre la fiche du point.
  const renderThumbnails = (pointIndexes: number[]) => {
    const mediaIndexes = pointIndexes.filter((index) =>
      isMediaPoint(points[index]),
    )
    if (mediaIndexes.length === 0) {
      return <p className="day-empty">Aucun média ce jour-là.</p>
    }
    return (
      <div className="day-thumbs">
        {mediaIndexes.map((index) => {
          const point = points[index]
          const media = resolvePointMedia(point, mediaLibrary)
          const isImage = media?.kind === 'image'
          return (
            <button
              key={point.id ?? `thumb-${index}`}
              type="button"
              className={`day-thumb type-${point.type}`}
              title={point.title}
              onClick={() => onSelectPoint(point)}
            >
              {isImage ? (
                <img
                  src={media.thumbnailSrc ?? media.src}
                  alt=""
                  decoding="async"
                  loading="lazy"
                  fetchPriority="low"
                />
              ) : (
                <span className="day-thumb-icon">
                  {point.type === 'video' ? (
                    <Play aria-hidden="true" size={16} />
                  ) : (
                    <PointTypeIcon type={point.type} />
                  )}
                </span>
              )}
            </button>
          )
        })}
      </div>
    )
  }

  const renderDaySection = (day: TripDay) => {
    const open = activeDayKey === day.key
    const dayStats = computeDayStats(day, traces)
    const tracesOfDay = dayTraces(day, traces)

    return (
      <section
        className="day-section"
        key={day.key}
        style={{ ['--day' as string]: day.color }}
      >
        <button
          type="button"
          className="day-section-header"
          aria-expanded={open}
          onClick={() => onSelectDay(open ? null : day.key)}
        >
          <span className="day-section-dot" />
          <span className="day-section-title">
            <strong>{day.label}</strong>
            <small>{day.dateLabel}</small>
          </span>
          <span className="day-section-meta">
            {dayStats.distanceMeters > 0 ? (
              <>
                <b>{formatDistance(dayStats.distanceMeters)}</b>
                <b>D+ {formatGain(dayStats.elevationGainMeters)}</b>
              </>
            ) : null}
            <b>
              {day.mediaCount} média{day.mediaCount > 1 ? 's' : ''}
            </b>
          </span>
          <ChevronRight
            aria-hidden="true"
            size={16}
            className="day-section-caret"
          />
        </button>
        {open ? (
          <div className="day-section-body">
            {tracesOfDay.length > 0 ? (
              <DayElevationSparkline traces={tracesOfDay} color={day.color} />
            ) : null}
            {renderThumbnails(day.pointIndexes)}
          </div>
        ) : null}
      </section>
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

      <ElevationProfile traces={traces} stats={stats} />

      {dayPlan.multiDay ? (
        <div className="day-sections">
          {dayPlan.days.map((day) => renderDaySection(day))}

          {dayPlan.undatedPointIndexes.length > 0 ? (
            <section className="day-section day-section-undated">
              <button
                type="button"
                className="day-section-header"
                aria-expanded={undatedOpen}
                onClick={() => setUndatedOpen((current) => !current)}
              >
                <span className="day-section-dot" />
                <span className="day-section-title">
                  <strong>Non datés</strong>
                  <small>toujours visibles sur la carte</small>
                </span>
                <span className="day-section-meta">
                  <b>
                    {dayPlan.undatedPointIndexes.length} point
                    {dayPlan.undatedPointIndexes.length > 1 ? 's' : ''}
                  </b>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  size={16}
                  className="day-section-caret"
                />
              </button>
              {undatedOpen ? (
                <div className="day-section-body">
                  {renderThumbnails(dayPlan.undatedPointIndexes)}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : (
        <div className="point-list">
          {points.length === 0 ? (
            <div className="empty-state">Aucun point pour le moment.</div>
          ) : null}

          {points.map((point, index) => {
            const media = resolvePointMedia(point, mediaLibrary)
            return (
              <button
                className="point-row"
                key={point.id ?? point.title ?? `point-${index}`}
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
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
