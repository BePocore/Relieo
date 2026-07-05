import { useMemo } from 'react'
import { distanceBetween } from '../lib/geo'
import type { Trace } from '../types'

type DayElevationSparklineProps = {
  traces: Trace[]
  color: string
}

// Mini profil d'altitude compact (aire + ligne), sans axe ni légende : la
// version « pellicule » du profil pour les sections par jour de l'onglet
// Parcours. Reste lisible même empilé (le grand ElevationProfile est réservé
// au résumé global en tête de panneau).
const WIDTH = 560
const HEIGHT = 56

export function DayElevationSparkline({
  traces,
  color,
}: DayElevationSparklineProps) {
  const paths = useMemo(() => {
    let distance = 0
    const points: Array<{ d: number; e: number }> = []
    for (const trace of traces) {
      trace.points.forEach((point, index) => {
        if (index > 0) {
          distance += distanceBetween(trace.points[index - 1], point)
        }
        if (point.ele !== undefined) points.push({ d: distance, e: point.ele })
      })
    }
    if (points.length < 2) return null

    const totalDistance = Math.max(points[points.length - 1].d, 1)
    let minE = points[0].e
    let maxE = points[0].e
    for (const point of points) {
      if (point.e < minE) minE = point.e
      if (point.e > maxE) maxE = point.e
    }
    const rangeE = Math.max(maxE - minE, 1)
    const toXY = (point: { d: number; e: number }): [number, number] => [
      (point.d / totalDistance) * WIDTH,
      HEIGHT - 4 - ((point.e - minE) / rangeE) * (HEIGHT - 10),
    ]

    const coords = points.map(toXY)
    const line = coords
      .map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ')
    const area = `M0 ${HEIGHT} ${coords
      .map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ')} L${WIDTH} ${HEIGHT} Z`
    return { line, area }
  }, [traces])

  if (!paths) return null

  return (
    <svg
      className="day-sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={paths.area} fill={color} fillOpacity={0.16} />
      <path
        d={paths.line}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
