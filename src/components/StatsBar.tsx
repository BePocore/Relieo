import {
  ArrowDownRight,
  ArrowUpRight,
  Map,
  Mountain,
  Route,
} from 'lucide-react'
import type { TrailStats } from '../types'
import {
  formatDistance,
  formatElevation,
  formatGain,
  formatLoss,
} from '../lib/format'

type StatsBarProps = {
  stats: TrailStats
  pointCount: number
}

export function StatsBar({ stats, pointCount }: StatsBarProps) {
  const items = [
    {
      label: 'Distance',
      value: formatDistance(stats.distanceMeters),
      icon: <Route aria-hidden="true" size={17} />,
    },
    {
      label: 'D+',
      value: formatGain(stats.elevationGainMeters),
      icon: <ArrowUpRight aria-hidden="true" size={17} />,
    },
    {
      label: 'D-',
      value: formatLoss(stats.elevationLossMeters),
      icon: <ArrowDownRight aria-hidden="true" size={17} />,
    },
    {
      label: 'Alt. max',
      value: formatElevation(stats.maxElevationMeters),
      icon: <Mountain aria-hidden="true" size={17} />,
    },
    {
      label: 'Points',
      value: pointCount.toLocaleString('fr-FR'),
      icon: <Map aria-hidden="true" size={17} />,
    },
  ]

  return (
    <dl className="stats-bar" aria-label="Statistiques">
      {items.map((item) => (
        <div className="stat-item" key={item.label}>
          <dt>
            {item.icon}
            {item.label}
          </dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
