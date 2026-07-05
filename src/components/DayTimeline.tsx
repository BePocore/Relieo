import { CalendarDays } from 'lucide-react'
import { computeDayStats, type DayPlan } from '../lib/days'
import { formatDistance, formatGain } from '../lib/format'
import type { Trace } from '../types'

type DayTimelineProps = {
  plan: DayPlan
  traces: Trace[]
  activeDayKey: string | null
  onSelectDay: (key: string | null) => void
}

// Timeline des jours du voyage en consultation :
//  - une fiche flottante dans le coin inférieur gauche (le jour actif : date,
//    distance, D+, photos/vidéos), à la couleur du tracé du jour ;
//  - une barre de chips centrée en bas (« Séjour » + une pastille colorée par
//    jour), qui filtre la carte et fait voler la caméra.
export function DayTimeline({
  plan,
  traces,
  activeDayKey,
  onSelectDay,
}: DayTimelineProps) {
  const activeDay = plan.days.find((day) => day.key === activeDayKey) ?? null
  const activeStats = activeDay ? computeDayStats(activeDay, traces) : null
  const photoCount = activeDay ? activeDay.mediaCount - activeDay.videoCount : 0

  return (
    <>
      {activeDay ? (
        <div className="day-card" style={{ ['--day' as string]: activeDay.color }}>
          <div className="day-card-title">
            <span className="day-card-dot" />
            <strong>{activeDay.label}</strong>
          </div>
          <div className="day-card-date">{activeDay.dateLabel}</div>
          <div className="day-card-stats">
            {activeStats && activeStats.distanceMeters > 0 ? (
              <>
                <span>
                  Distance <b>{formatDistance(activeStats.distanceMeters)}</b>
                </span>
                <span>
                  D+ <b>{formatGain(activeStats.elevationGainMeters)}</b>
                </span>
              </>
            ) : null}
            <span>
              Photos <b>{photoCount}</b>
            </span>
            <span>
              Vidéos <b>{activeDay.videoCount}</b>
            </span>
          </div>
        </div>
      ) : null}

      <div
        className="day-timeline-bar"
        role="toolbar"
        aria-label="Jours du voyage"
      >
        <button
          type="button"
          className="day-chip"
          aria-pressed={activeDayKey === null}
          title="Tout le séjour"
          onClick={() => onSelectDay(null)}
        >
          <CalendarDays aria-hidden="true" size={14} />
          <span>Séjour</span>
        </button>
        {plan.days.map((day) => (
          <button
            key={day.key}
            type="button"
            className="day-chip day-chip-day"
            style={{ ['--day' as string]: day.color }}
            aria-pressed={activeDayKey === day.key}
            title={`${day.label} · ${day.dateLabel}`}
            onClick={() =>
              onSelectDay(activeDayKey === day.key ? null : day.key)
            }
          >
            <span className="day-chip-dot" />J{day.index}
          </button>
        ))}
      </div>
    </>
  )
}
