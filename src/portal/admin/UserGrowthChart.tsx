import { useMemo, useState } from 'react'

export type ChartSeries = {
  id: string
  label: string
  color: string
  values: number[]
}

type Props = {
  labels: string[]
  series: ChartSeries[]
}

// Géométrie du dessin (unités SVG, le rendu est mis à l'échelle en CSS).
const W = 760
const H = 280
const PAD = { top: 18, right: 18, bottom: 30, left: 40 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

// Arrondit le haut de l'axe Y à une valeur « propre ».
const niceMax = (value: number): number => {
  if (value <= 0) return 4
  const pow = Math.pow(10, Math.floor(Math.log10(value)))
  const step = pow <= 1 ? 1 : pow / 2
  return Math.max(step, Math.ceil(value / step) * step)
}

// Courbe lissée (Catmull-Rom converti en Béziers) pour un rendu type capture.
const smoothPath = (pts: Array<{ x: number; y: number }>): string => {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
  const d = [`M ${pts[0].x} ${pts[0].y}`]
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const t = 0.16
    const c1x = p1.x + (p2.x - p0.x) * t
    const c1y = p1.y + (p2.y - p0.y) * t
    const c2x = p2.x - (p3.x - p1.x) * t
    const c2y = p2.y - (p3.y - p1.y) * t
    d.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`)
  }
  return d.join(' ')
}

export function UserGrowthChart({ labels, series }: Props) {
  const [hover, setHover] = useState<number | null>(null)

  const { ticks, xOf, yOf } = useMemo(() => {
    const allValues = series.flatMap((s) => s.values)
    const max = niceMax(Math.max(1, ...allValues))
    const count = labels.length
    const xOf = (i: number) =>
      PAD.left + (count <= 1 ? PLOT_W / 2 : (i / (count - 1)) * PLOT_W)
    const yOf = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H
    const ticks = Array.from({ length: 5 }, (_, i) => (max / 4) * i)
    return { ticks, xOf, yOf }
  }, [labels.length, series])

  // Affiche un libellé d'axe X sur deux au maximum ~8 pour ne pas surcharger.
  const labelStep = Math.max(1, Math.ceil(labels.length / 8))

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fx = ((event.clientX - rect.left) / rect.width) * W
    const frac = (fx - PAD.left) / PLOT_W
    const idx = Math.round(frac * (labels.length - 1))
    setHover(Math.min(labels.length - 1, Math.max(0, idx)))
  }

  return (
    <div
      className="admin-chart"
      onMouseLeave={() => setHover(null)}
      onMouseMove={onMove}
    >
      <svg preserveAspectRatio="none" role="img" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          {series.map((s) => (
            <linearGradient id={`grad-${s.id}`} key={s.id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Grille + axe Y */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="admin-chart-grid"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yOf(t)}
              y2={yOf(t)}
            />
            <text className="admin-chart-axis" x={PAD.left - 10} y={yOf(t) + 4} textAnchor="end">
              {Math.round(t)}
            </text>
          </g>
        ))}

        {/* Aires + courbes */}
        {series.map((s) => {
          const pts = s.values.map((v, i) => ({ x: xOf(i), y: yOf(v) }))
          const line = smoothPath(pts)
          const area = `${line} L ${xOf(s.values.length - 1)} ${yOf(0)} L ${xOf(0)} ${yOf(0)} Z`
          return (
            <g key={s.id}>
              <path d={area} fill={`url(#grad-${s.id})`} />
              <path className="admin-chart-line" d={line} stroke={s.color} />
            </g>
          )
        })}

        {/* Repère de survol */}
        {hover !== null ? (
          <g>
            <line
              className="admin-chart-cursor"
              x1={xOf(hover)}
              x2={xOf(hover)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
            />
            {series.map((s) => (
              <circle
                cx={xOf(hover)}
                cy={yOf(s.values[hover])}
                fill={s.color}
                key={s.id}
                r={4}
                stroke="#fff"
                strokeWidth={2}
              />
            ))}
          </g>
        ) : null}

        {/* Axe X */}
        {labels.map((label, i) =>
          i % labelStep === 0 || i === labels.length - 1 ? (
            <text
              className="admin-chart-axis"
              key={`${label}-${i}`}
              textAnchor="middle"
              x={xOf(i)}
              y={H - 8}
            >
              {label}
            </text>
          ) : null,
        )}
      </svg>

      {hover !== null ? (
        <div
          className="admin-chart-tip"
          style={{
            left: `${(xOf(hover) / W) * 100}%`,
            top: `${(PAD.top / H) * 100}%`,
          }}
        >
          <p className="admin-chart-tip-date">{labels[hover]}</p>
          {series.map((s) => (
            <div className="admin-chart-tip-row" key={s.id}>
              <span style={{ background: s.color }} />
              <span>{s.label}</span>
              <strong>{s.values[hover]}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
