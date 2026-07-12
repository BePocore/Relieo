import {
  ArrowDownRight,
  ArrowUpRight,
  Images,
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
  // Carte « exposition de photos » : pas de trace GPS, donc aucune stat de
  // parcours (distance/D+/D-/altitude), seulement les médias et points.
  galleryMode?: boolean
  mediaCount?: number
}

export function StatsBar({
  stats,
  pointCount,
  galleryMode = false,
  mediaCount = 0,
}: StatsBarProps) {
  const items = galleryMode
    ? [
        {
          label: 'Médias',
          value: mediaCount.toLocaleString('fr-FR'),
          icon: <Images aria-hidden="true" size={17} />,
        },
        {
          label: 'Points',
          value: pointCount.toLocaleString('fr-FR'),
          icon: <Map aria-hidden="true" size={17} />,
        },
      ]
    : [
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
