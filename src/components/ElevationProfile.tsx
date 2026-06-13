import { Activity } from 'lucide-react'
import type { Trace, TrailStats } from '../types'
import { distanceBetween } from '../lib/geo'
import { traceColor } from '../lib/mapStyles'
import {
  formatDistance,
  formatElevation,
  formatGain,
  formatLoss,
} from '../lib/format'

type ElevationProfileProps = {
  traces: Trace[]
  stats: TrailStats
}

type ProfilePoint = {
  distance: number
  elevation: number
}

type ProfileSegment = {
  color: string
  points: ProfilePoint[]
}

// Un segment coloré par trace, avec une distance cumulée continue (sans
// compter l'écart entre la fin d'une trace et le début de la suivante).
const buildSegments = (traces: Trace[]): ProfileSegment[] => {
  let distance = 0
  const segments: ProfileSegment[] = []

  traces.forEach((trace, index) => {
    const points: ProfilePoint[] = []
    trace.points.forEach((point, pointIndex) => {
      if (pointIndex > 0) {
        distance += distanceBetween(trace.points[pointIndex - 1], point)
      }
      if (point.ele !== undefined) {
        points.push({ distance, elevation: point.ele })
      }
    })
    if (points.length > 0) {
      segments.push({ color: trace.color ?? traceColor(index), points })
    }
  })

  return segments
}

export function ElevationProfile({ traces, stats }: ElevationProfileProps) {
  const segments = buildSegments(traces)
  const profile = segments.flatMap((segment) => segment.points)

  if (profile.length < 2 || stats.maxElevationMeters === null) {
    return (
      <section className="elevation-card" aria-label="Profil d'altitude">
        <div className="elevation-heading">
          <Activity aria-hidden="true" size={17} />
          <strong>Profil d'altitude</strong>
        </div>
        <div className="empty-state">Aucune altitude dans le GPX.</div>
      </section>
    )
  }

  const width = 320
  const height = 136
  const paddingX = 10
  const graphTop = 12
  const graphBottom = 104
  const axisLabelY = 126
  const minElevation = stats.minElevationMeters ?? stats.maxElevationMeters
  const maxElevation = stats.maxElevationMeters
  const elevationRange = Math.max(maxElevation - minElevation, 1)
  const distanceRange = Math.max(stats.distanceMeters, 1)

  const toXY = (point: ProfilePoint): string => {
    const x =
      paddingX + (point.distance / distanceRange) * (width - paddingX * 2)
    const y =
      graphBottom -
      ((point.elevation - minElevation) / elevationRange) *
        (graphBottom - graphTop)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }

  const areaPoints = [
    `${paddingX},${graphBottom}`,
    ...profile.map(toXY),
    `${width - paddingX},${graphBottom}`,
  ].join(' ')
  const distanceTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4
    const distanceKm = (stats.distanceMeters * ratio) / 1000
    const anchor: 'start' | 'middle' | 'end' =
      index === 0 ? 'start' : index === 4 ? 'end' : 'middle'

    return {
      x: paddingX + ratio * (width - paddingX * 2),
      label: `${distanceKm.toLocaleString('fr-FR', {
        maximumFractionDigits: 1,
      })} km`,
      anchor,
    }
  })

  return (
    <section className="elevation-card" aria-label="Profil d'altitude">
      <div className="elevation-heading">
        <Activity aria-hidden="true" size={17} />
        <strong>Profil d'altitude</strong>
      </div>

      <svg
        className="elevation-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Distance ${formatDistance(
          stats.distanceMeters,
        )}, denivele positif ${formatGain(
          stats.elevationGainMeters,
        )}, denivele negatif ${formatLoss(stats.elevationLossMeters)}`}
      >
        <defs>
          <linearGradient id="profile-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#0f766e" stopOpacity="0.38" />
            <stop offset="100%" stopColor="#0f766e" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        <polyline points={areaPoints} fill="url(#profile-fill)" />
        {segments.map((segment, index) => (
          <polyline
            key={index}
            points={segment.points.map(toXY).join(' ')}
            fill="none"
            stroke={segment.color}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
          />
        ))}
        <line
          className="elevation-axis-line"
          x1={paddingX}
          x2={width - paddingX}
          y1={graphBottom}
          y2={graphBottom}
        />
        {distanceTicks.map((tick) => (
          <g key={`${tick.x}-${tick.label}`}>
            <line
              className="elevation-axis-tick"
              x1={tick.x}
              x2={tick.x}
              y1={graphBottom}
              y2={graphBottom + 5}
            />
            <text
              className="elevation-axis-label"
              textAnchor={tick.anchor}
              x={tick.x}
              y={axisLabelY}
            >
              {tick.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="elevation-summary">
        <span>
          <small>Min</small>
          <strong>{formatElevation(stats.minElevationMeters)}</strong>
        </span>
        <span>
          <small>Max</small>
          <strong>{formatElevation(stats.maxElevationMeters)}</strong>
        </span>
        <span>
          <small>D+</small>
          <strong>{formatGain(stats.elevationGainMeters)}</strong>
        </span>
        <span>
          <small>D-</small>
          <strong>{formatLoss(stats.elevationLossMeters)}</strong>
        </span>
      </div>
    </section>
  )
}
