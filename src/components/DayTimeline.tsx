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

// Timeline des jours du voyage, posée en bas de la carte de consultation :
// « Séjour » = vue complète, un chip par jour filtre la carte (les traces et
// médias des autres jours s'atténuent) et fait voler la caméra vers le jour.
export function DayTimeline({
  plan,
  traces,
  activeDayKey,
  onSelectDay,
}: DayTimelineProps) {
  const activeDay = plan.days.find((day) => day.key === activeDayKey) ?? null
  const activeStats = activeDay ? computeDayStats(activeDay, traces) : null

  return (
    <div className="day-timeline">
      {activeDay ? (
        <div className="day-timeline-summary">
          <strong>{activeDay.label}</strong>
          <span>{activeDay.dateLabel}</span>
          {activeStats && activeStats.distanceMeters > 0 ? (
            <span>
              {formatDistance(activeStats.distanceMeters)} · D+{' '}
              {formatGain(activeStats.elevationGainMeters)}
            </span>
          ) : null}
          <span>
            {activeDay.mediaCount} média{activeDay.mediaCount > 1 ? 's' : ''}
          </span>
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
            className="day-chip"
            aria-pressed={activeDayKey === day.key}
            title={`${day.label} · ${day.dateLabel}`}
            onClick={() =>
              onSelectDay(activeDayKey === day.key ? null : day.key)
            }
          >
            J{day.index}
          </button>
        ))}
      </div>
    </div>
  )
}
