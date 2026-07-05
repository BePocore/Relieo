import { useState } from 'react'
import { ChevronRight, Mountain } from 'lucide-react'
import { ElevationProfile } from './ElevationProfile'
import { PointDetail } from './PointDetail'
import { PointTypeIcon } from './PointTypeIcon'
import { pointTypeLabels } from '../lib/pointMeta'
import { resolvePointMedia } from '../lib/media'
import {
  computeDayStats,
  dayTraces,
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

  const renderPointRow = (point: TrailPoint, key: string) => {
    const media = resolvePointMedia(point, mediaLibrary)

    return (
      <button
        className="point-row"
        key={key}
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
  }

  const renderDaySection = (day: TripDay) => {
    const open = activeDayKey === day.key
    const dayStats = computeDayStats(day, traces)
    const tracesOfDay = dayTraces(day, traces)

    return (
      <section className="day-section" key={day.key}>
        <button
          type="button"
          className="day-section-header"
          aria-expanded={open}
          onClick={() => onSelectDay(open ? null : day.key)}
        >
          <ChevronRight
            aria-hidden="true"
            size={16}
            className="day-section-caret"
          />
          <span className="day-section-title">
            <strong>{day.label}</strong>
            <small>{day.dateLabel}</small>
          </span>
          <span className="day-section-meta">
            {dayStats.distanceMeters > 0 ? (
              <>
                {formatDistance(dayStats.distanceMeters)} · D+{' '}
                {formatGain(dayStats.elevationGainMeters)} ·{' '}
              </>
            ) : null}
            {day.mediaCount} média{day.mediaCount > 1 ? 's' : ''}
          </span>
        </button>
        {open ? (
          <div className="day-section-body">
            {tracesOfDay.length > 0 ? (
              <ElevationProfile traces={tracesOfDay} stats={dayStats} />
            ) : null}
            <div className="point-list">
              {day.pointIndexes.length === 0 ? (
                <div className="empty-state">Aucun point ce jour-là.</div>
              ) : (
                day.pointIndexes.map((index) =>
                  renderPointRow(
                    points[index],
                    points[index].id ?? `day-point-${index}`,
                  ),
                )
              )}
            </div>
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
        <>
          {dayPlan.days.map((day) => renderDaySection(day))}

          {dayPlan.undatedPointIndexes.length > 0 ? (
            <section className="day-section">
              <button
                type="button"
                className="day-section-header"
                aria-expanded={undatedOpen}
                onClick={() => setUndatedOpen((current) => !current)}
              >
                <ChevronRight
                  aria-hidden="true"
                  size={16}
                  className="day-section-caret"
                />
                <span className="day-section-title">
                  <strong>Non datés</strong>
                  <small>toujours visibles sur la carte</small>
                </span>
                <span className="day-section-meta">
                  {dayPlan.undatedPointIndexes.length} point
                  {dayPlan.undatedPointIndexes.length > 1 ? 's' : ''}
                </span>
              </button>
              {undatedOpen ? (
                <div className="day-section-body">
                  <div className="point-list">
                    {dayPlan.undatedPointIndexes.map((index) =>
                      renderPointRow(
                        points[index],
                        points[index].id ?? `undated-point-${index}`,
                      ),
                    )}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : (
        <div className="point-list">
          {points.length === 0 ? (
            <div className="empty-state">Aucun point pour le moment.</div>
          ) : null}

          {points.map((point, index) =>
            renderPointRow(point, point.id ?? point.title ?? `point-${index}`),
          )}
        </div>
      )}
    </div>
  )
}
