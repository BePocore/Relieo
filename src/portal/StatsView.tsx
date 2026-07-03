import { useEffect, useMemo, useState } from 'react'
import { Eye, Loader2, Trophy, TrendingUp } from 'lucide-react'
import { getIdToken } from './firebase'

type DayPoint = { date: string; views: number }
type HikeViews = { code: string; title: string; views: number }
type StatsData = {
  total: number
  last30: DayPoint[]
  perHike: HikeViews[]
}

// Lecture à la demande : seul l'onglet Statistiques appelle ?withStats=1, donc
// le serveur ne lit Firestore que dans ce cas (le dashboard normal ne paie rien).
const loadStats = async (): Promise<StatsData> => {
  const token = await getIdToken()
  if (!token) throw new Error('Connexion requise.')
  const response = await fetch('/api/hikes?withStats=1', {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = (await response.json().catch(() => null)) as
    | { stats?: StatsData; message?: string }
    | null
  if (!response.ok || !data?.stats) {
    throw new Error(data?.message ?? 'Statistiques indisponibles.')
  }
  return data.stats
}

// "2026-06-24" -> "24/06"
const shortDay = (date: string): string => {
  const [, month, day] = date.split('-')
  return `${day}/${month}`
}

const formatNumber = (value: number): string => value.toLocaleString('fr-FR')

// --- Courbe des vues sur 30 jours (SVG autonome, aux couleurs du portail) -----

const W = 760
const H = 260
const PAD = { top: 18, right: 18, bottom: 28, left: 38 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

// Graduations entières et distinctes (les vues sont des effectifs).
const buildTicks = (rawMax: number): number[] => {
  const top = Math.max(1, rawMax)
  const step = Math.max(1, Math.ceil(top / 4))
  const max = Math.ceil(top / step) * step
  const ticks: number[] = []
  for (let value = 0; value <= max; value += step) ticks.push(value)
  return ticks
}

// Courbe lissée monotone (tangentes Fritsch-Carlson -> Béziers) : contrairement
// à un Catmull-Rom, elle ne déborde jamais des valeurs (pas de creux sous zéro
// juste avant un pic qui suit une série plate).
const smoothPath = (pts: Array<{ x: number; y: number }>): string => {
  const n = pts.length
  if (n === 0) return ''
  if (n === 1) return `M ${pts[0].x} ${pts[0].y}`
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    slopes.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x))
  }
  const tangents: number[] = [slopes[0]]
  for (let i = 1; i < n - 1; i += 1) {
    const a = slopes[i - 1]
    const b = slopes[i]
    tangents.push(a * b <= 0 ? 0 : (2 * a * b) / (a + b))
  }
  tangents.push(slopes[n - 2])
  const r = (v: number) => Math.round(v * 100) / 100
  const d = [`M ${r(pts[0].x)} ${r(pts[0].y)}`]
  for (let i = 0; i < n - 1; i += 1) {
    const dx = (pts[i + 1].x - pts[i].x) / 3
    d.push(
      `C ${r(pts[i].x + dx)} ${r(pts[i].y + tangents[i] * dx)}` +
        ` ${r(pts[i + 1].x - dx)} ${r(pts[i + 1].y - tangents[i + 1] * dx)}` +
        ` ${r(pts[i + 1].x)} ${r(pts[i + 1].y)}`,
    )
  }
  return d.join(' ')
}

function ViewsChart({ points }: { points: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const { ticks, xOf, yOf, line, area } = useMemo(() => {
    const values = points.map((point) => point.views)
    const ticks = buildTicks(Math.max(1, ...values))
    const max = ticks[ticks.length - 1]
    const count = points.length
    const xOf = (i: number) =>
      PAD.left + (count <= 1 ? PLOT_W / 2 : (i / (count - 1)) * PLOT_W)
    const yOf = (v: number) => PAD.top + PLOT_H - (v / max) * PLOT_H
    const coords = values.map((v, i) => ({ x: xOf(i), y: yOf(v) }))
    const line = smoothPath(coords)
    const area =
      coords.length > 0
        ? `${line} L ${xOf(values.length - 1)} ${yOf(0)} L ${xOf(0)} ${yOf(0)} Z`
        : ''
    return { ticks, xOf, yOf, line, area }
  }, [points])

  // Libellés ancrés sur le dernier jour puis un tous les `labelStep` en
  // remontant : le dernier est toujours affiché sans chevaucher son voisin.
  const labelStep = Math.max(1, Math.ceil(points.length / 8))
  const showLabel = (i: number) => (points.length - 1 - i) % labelStep === 0

  const onMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fx = ((event.clientX - rect.left) / rect.width) * W
    const frac = (fx - PAD.left) / PLOT_W
    const idx = Math.round(frac * (points.length - 1))
    setHover(Math.min(points.length - 1, Math.max(0, idx)))
  }

  return (
    <div
      className="stats-chart"
      onMouseLeave={() => setHover(null)}
      onMouseMove={onMove}
    >
      <svg preserveAspectRatio="none" role="img" viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id="stats-area-grad" x1="0" x2="0" y1="0" y2="1">
            <stop className="stats-area-from" offset="0%" />
            <stop className="stats-area-to" offset="100%" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className="stats-chart-grid"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
            />
            <text
              className="stats-chart-axis"
              x={PAD.left - 9}
              y={yOf(tick) + 4}
              textAnchor="end"
            >
              {Math.round(tick)}
            </text>
          </g>
        ))}

        {area ? <path d={area} fill="url(#stats-area-grad)" /> : null}
        {line ? <path className="stats-chart-line" d={line} /> : null}

        {hover !== null ? (
          <g>
            <line
              className="stats-chart-cursor"
              x1={xOf(hover)}
              x2={xOf(hover)}
              y1={PAD.top}
              y2={PAD.top + PLOT_H}
            />
            <circle
              className="stats-chart-dot"
              cx={xOf(hover)}
              cy={yOf(points[hover].views)}
              r={4}
            />
          </g>
        ) : null}

        {points.map((point, i) =>
          showLabel(i) ? (
            <text
              className="stats-chart-axis"
              key={point.date}
              textAnchor="middle"
              x={xOf(i)}
              y={H - 8}
            >
              {shortDay(point.date)}
            </text>
          ) : null,
        )}
      </svg>

      {hover !== null ? (
        <div
          className="stats-chart-tip"
          style={{
            left: `${Math.min(86, Math.max(14, (xOf(hover) / W) * 100))}%`,
          }}
        >
          <p className="stats-chart-tip-date">{shortDay(points[hover].date)}</p>
          <strong>
            {formatNumber(points[hover].views)} vue
            {points[hover].views > 1 ? 's' : ''}
          </strong>
        </div>
      ) : null}
    </div>
  )
}

// --- Vue principale -----------------------------------------------------------

export function StatsView() {
  const [data, setData] = useState<StatsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    loadStats()
      .then((stats) => {
        if (!alive) return
        setData(stats)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : 'Erreur inattendue.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const views30 = useMemo(
    () => (data ? data.last30.reduce((sum, day) => sum + day.views, 0) : 0),
    [data],
  )
  const ranked = useMemo(
    () => (data ? data.perHike.filter((hike) => hike.views > 0) : []),
    [data],
  )
  const topHike = ranked[0] ?? null
  const maxViews = Math.max(1, ...ranked.map((hike) => hike.views))

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="portal-kicker">Statistiques</p>
          <h1>Audience de vos cartes</h1>
          <p>Le nombre de consultations de vos cartes publiées (vues anonymes).</p>
        </div>
      </header>

      {loading ? (
        <div className="stats-state">
          <Loader2 className="stats-spin" size={26} />
          <p>Chargement des statistiques…</p>
        </div>
      ) : error ? (
        <div className="stats-state">
          <p className="auth-error">{error}</p>
        </div>
      ) : !data || data.perHike.length === 0 ? (
        <div className="stats-state">
          <span className="stats-state-icon"><Eye size={26} /></span>
          <strong>Pas encore de carte</strong>
          <p>Publiez une carte pour commencer à recueillir des vues.</p>
        </div>
      ) : data.total === 0 ? (
        <div className="stats-state">
          <span className="stats-state-icon"><Eye size={26} /></span>
          <strong>Aucune vue pour l’instant</strong>
          <p>Partagez le lien de vos cartes publiées : les consultations s’afficheront ici.</p>
        </div>
      ) : (
        <>
          <section className="stats-summary" aria-label="Résumé des vues">
            <article className="summary-card featured">
              <span><Eye size={19} /></span>
              <p>Vues totales</p>
              <strong>{formatNumber(data.total)}</strong>
              <small>sur toutes vos cartes</small>
            </article>
            <article className="summary-card">
              <span><TrendingUp size={19} /></span>
              <p>30 derniers jours</p>
              <strong>{formatNumber(views30)}</strong>
              <small>vues récentes</small>
            </article>
            <article className="summary-card">
              <span><Trophy size={19} /></span>
              <p>Carte la plus vue</p>
              <strong>{topHike ? formatNumber(topHike.views) : '—'}</strong>
              <small>{topHike ? topHike.title : 'Aucune vue'}</small>
            </article>
          </section>

          <section className="stats-panel">
            <div className="section-heading">
              <div>
                <h2>Vues par jour</h2>
                <p>30 derniers jours</p>
              </div>
            </div>
            <ViewsChart points={data.last30} />
          </section>

          {ranked.length > 0 ? (
            <section className="stats-panel">
              <div className="section-heading">
                <div>
                  <h2>Classement des cartes</h2>
                  <p>{ranked.length} carte{ranked.length > 1 ? 's' : ''} consultée{ranked.length > 1 ? 's' : ''}</p>
                </div>
              </div>
              <ul className="stats-hike-list">
                {ranked.map((hike, index) => (
                  <li className="stats-hike-row" key={hike.code}>
                    <span className="stats-hike-rank">{index + 1}</span>
                    <div className="stats-hike-main">
                      <strong>{hike.title}</strong>
                      <div className="stats-hike-bar">
                        <span style={{ width: `${(hike.views / maxViews) * 100}%` }} />
                      </div>
                    </div>
                    <span className="stats-hike-views">{formatNumber(hike.views)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </>
  )
}
