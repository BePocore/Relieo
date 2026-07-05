import type {
  ImportedMedia,
  Trace,
  TrailPoint,
  TrailStats,
} from '../types'
import { computeTrailStats, distanceBetween } from './geo'
import { findPointMediaItem } from './media'
import { traceColor } from './mapStyles'

// ---------------------------------------------------------------------------
// Plan de journées d'une carte : regroupe traces et points médias par jour
// calendaire, entièrement calculé au chargement (rien n'est persisté, les
// vieilles cartes en profitent sans migration). Cascade de rattachement d'un
// point, du signal le plus fiable au moins fiable :
//   1. 'exif'          date de prise de vue du média (takenAt)
//   2. 'trace-time'    point GPX horodaté le plus proche (≤ 250 m)
//   3. 'filename'      date dans le nom de fichier (IMG_20260812_...)
//   4. 'trace-nearest' jour du tracé le plus proche (≤ 2 km)
//   5. non daté        (toujours visible, jamais filtré sur la carte)
// Un tracé se date par ses propres horodatages GPX (majorité), sinon par le
// vote des médias EXIF posés dessus (inférence inverse), sinon reste non daté.
// ---------------------------------------------------------------------------

export type PointDaySource = 'exif' | 'trace-time' | 'filename' | 'trace-nearest'
export type TraceDaySource = 'gpx' | 'media-vote'

export type TripDay = {
  key: string // date locale 'YYYY-MM-DD'
  index: number // 1..N chronologique
  label: string // « Jour 1 »
  dateLabel: string // « lun. 10 août »
  // Couleur du 1er tracé du jour (comme sur la carte) ; accent par défaut si
  // le jour n'a que des médias, sans tracé.
  color: string
  traceIds: string[]
  pointIndexes: number[] // indexes dans le tableau points fourni
  mediaCount: number // photos + vidéos + 360
  videoCount: number
}

const DEFAULT_DAY_COLOR = '#4fd1a1'

export type DayPlan = {
  days: TripDay[]
  // Alignés sur le tableau points fourni (index par index).
  pointDayKeys: Array<string | null>
  pointDaySources: Array<PointDaySource | null>
  traceDayKeys: Record<string, string | null>
  traceDaySources: Record<string, TraceDaySource | null>
  undatedPointIndexes: number[]
  multiDay: boolean
}

// Une « journée » du récit commence à 04:00 (heure locale du voyage) : les
// photos de la soirée prises après minuit restent rattachées au jour d'avant.
const DAY_START_HOUR = 4
// Distance max pour hériter de la date d'un point GPX horodaté.
const NEAR_TRACE_METERS = 250
// Distance max du repli « jour du tracé le plus proche ».
const FALLBACK_TRACE_METERS = 2_000
// Les traces sont denses (1 pt/s) : on les échantillonne (~400 points
// comparés par trace) pour garder le calcul instantané.
const TRACE_SAMPLE_TARGET = 400

export const isMediaPoint = (point: TrailPoint): boolean =>
  point.type === 'photo' ||
  point.type === 'video' ||
  point.type === '360' ||
  Boolean(point.image || point.video || point.skypixelUrl)

const sampleStride = (length: number): number =>
  Math.max(1, Math.ceil(length / TRACE_SAMPLE_TARGET))

// Fuseau approximatif du voyage déduit de la longitude médiane (fuseau
// « solaire », à ±1 h près) : ni l'EXIF ni le GPX n'embarquent le fuseau, et
// le navigateur du visiteur peut être n'importe où dans le monde. Suffisant
// pour découper des journées ; affinable plus tard au Studio (phase 2).
const tripUtcOffsetHours = (
  traces: Trace[],
  points: TrailPoint[],
): number => {
  const lngs: number[] = []
  for (const trace of traces) {
    const stride = sampleStride(trace.points.length)
    for (let i = 0; i < trace.points.length; i += stride) {
      lngs.push(trace.points[i].lng)
    }
  }
  if (lngs.length === 0) for (const point of points) lngs.push(point.lng)
  if (lngs.length === 0) return 0
  lngs.sort((a, b) => a - b)
  const median = lngs[Math.floor(lngs.length / 2)]
  return Math.max(-12, Math.min(14, Math.round(median / 15)))
}

// Instant ISO → clé de jour local ('YYYY-MM-DD'), bornes de journée à 04:00.
const localDayKey = (
  iso: string | undefined,
  offsetHours: number,
): string | null => {
  if (!iso) return null
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return null
  const shifted = new Date(time + (offsetHours - DAY_START_HOUR) * 3_600_000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Date dans le nom de fichier (IMG_20260812_1432.jpg, VID-20260812-WA0003,
// 2026-08-12 14.32.11.mov...). Suggestion seulement : validée comme vraie date.
const filenameDayKey = (name: string | undefined): string | null => {
  if (!name) return null
  const match = name.match(
    /(?:^|\D)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/,
  )
  if (!match) return null
  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  if (
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return null
  }
  return `${year}-${month}-${day}`
}

const dayDateLabel = (key: string): string => {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  return date.toLocaleDateString('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
}

const majorityKey = (counts: Map<string, number>): string | null => {
  let best: string | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    // Égalité : le jour le plus ancien gagne (déterministe).
    if (count > bestCount || (count === bestCount && best !== null && key < best)) {
      best = key
      bestCount = count
    }
  }
  return best
}

type SampledTracePoint = {
  lat: number
  lng: number
  timeKey: string | null
}

export const buildDayPlan = (
  traces: Trace[],
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
): DayPlan => {
  const offset = tripUtcOffsetHours(traces, points)

  // Échantillon de chaque trace, avec la clé de jour de chaque point horodaté.
  const sampledByTrace = new Map<string, SampledTracePoint[]>()
  for (const trace of traces) {
    const stride = sampleStride(trace.points.length)
    const sampled: SampledTracePoint[] = []
    for (let i = 0; i < trace.points.length; i += stride) {
      const point = trace.points[i]
      sampled.push({
        lat: point.lat,
        lng: point.lng,
        timeKey: localDayKey(point.time, offset),
      })
    }
    sampledByTrace.set(trace.id, sampled)
  }

  // 1. Tracé → jour, par majorité de ses horodatages GPX.
  const traceDayKeys: Record<string, string | null> = {}
  const traceDaySources: Record<string, TraceDaySource | null> = {}
  for (const trace of traces) {
    const counts = new Map<string, number>()
    for (const sample of sampledByTrace.get(trace.id) ?? []) {
      if (sample.timeKey) {
        counts.set(sample.timeKey, (counts.get(sample.timeKey) ?? 0) + 1)
      }
    }
    const key = majorityKey(counts)
    traceDayKeys[trace.id] = key
    traceDaySources[trace.id] = key ? 'gpx' : null
  }

  // 2. Points → jour, première passe : la date EXIF du média (takenAt).
  const mediaItems = points.map((point) =>
    findPointMediaItem(point, mediaLibrary),
  )
  const pointDayKeys: Array<string | null> = points.map(() => null)
  const pointDaySources: Array<PointDaySource | null> = points.map(() => null)
  points.forEach((_, index) => {
    const key = localDayKey(mediaItems[index]?.takenAt, offset)
    if (key) {
      pointDayKeys[index] = key
      pointDaySources[index] = 'exif'
    }
  })

  // 3. Tracé sans horodatage → inférence inverse : vote des médias datés par
  //    EXIF posés dessus (≤ 250 m).
  for (const trace of traces) {
    if (traceDayKeys[trace.id]) continue
    const sampled = sampledByTrace.get(trace.id) ?? []
    if (sampled.length === 0) continue
    const counts = new Map<string, number>()
    points.forEach((point, index) => {
      const key = pointDayKeys[index]
      if (!key || pointDaySources[index] !== 'exif') return
      let nearest = Number.POSITIVE_INFINITY
      for (const sample of sampled) {
        const distance = distanceBetween(point, sample)
        if (distance < nearest) nearest = distance
      }
      if (nearest <= NEAR_TRACE_METERS) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    })
    const key = majorityKey(counts)
    if (key) {
      traceDayKeys[trace.id] = key
      traceDaySources[trace.id] = 'media-vote'
    }
  }

  // 4. Cascade pour les points encore sans jour.
  points.forEach((point, index) => {
    if (pointDayKeys[index]) return

    // Point GPX horodaté le plus proche, et tracé daté le plus proche.
    let nearestTimed: { distance: number; key: string } | null = null
    let nearestTrace: { distance: number; key: string } | null = null
    for (const trace of traces) {
      const traceKey = traceDayKeys[trace.id]
      for (const sample of sampledByTrace.get(trace.id) ?? []) {
        const distance = distanceBetween(point, sample)
        if (
          sample.timeKey &&
          (nearestTimed === null || distance < nearestTimed.distance)
        ) {
          nearestTimed = { distance, key: sample.timeKey }
        }
        if (
          traceKey &&
          (nearestTrace === null || distance < nearestTrace.distance)
        ) {
          nearestTrace = { distance, key: traceKey }
        }
      }
    }

    if (nearestTimed && nearestTimed.distance <= NEAR_TRACE_METERS) {
      pointDayKeys[index] = nearestTimed.key
      pointDaySources[index] = 'trace-time'
      return
    }

    const nameKey =
      filenameDayKey(mediaItems[index]?.name) ?? filenameDayKey(point.mediaName)
    if (nameKey) {
      pointDayKeys[index] = nameKey
      pointDaySources[index] = 'filename'
      return
    }

    if (nearestTrace && nearestTrace.distance <= FALLBACK_TRACE_METERS) {
      pointDayKeys[index] = nearestTrace.key
      pointDaySources[index] = 'trace-nearest'
    }
  })

  // 5. Assemblage chronologique des journées.
  const keys = new Set<string>()
  for (const trace of traces) {
    const key = traceDayKeys[trace.id]
    if (key) keys.add(key)
  }
  for (const key of pointDayKeys) if (key) keys.add(key)
  const sortedKeys = [...keys].sort()

  const days: TripDay[] = sortedKeys.map((key, i) => {
    const pointIndexes: number[] = []
    points.forEach((_, index) => {
      if (pointDayKeys[index] === key) pointIndexes.push(index)
    })
    const traceIds = traces
      .filter((trace) => traceDayKeys[trace.id] === key)
      .map((trace) => trace.id)
    // Couleur = celle du 1er tracé du jour, telle qu'affichée sur la carte
    // (trace.color sinon traceColor(indexGlobal)).
    const firstTraceIndex =
      traceIds.length > 0
        ? traces.findIndex((trace) => trace.id === traceIds[0])
        : -1
    const color =
      firstTraceIndex >= 0
        ? traces[firstTraceIndex].color ?? traceColor(firstTraceIndex)
        : DEFAULT_DAY_COLOR
    const mediaIndexes = pointIndexes.filter((index) =>
      isMediaPoint(points[index]),
    )
    const videoCount = mediaIndexes.filter(
      (index) =>
        points[index].type === 'video' ||
        Boolean(points[index].video) ||
        mediaItems[index]?.kind === 'video',
    ).length
    return {
      key,
      index: i + 1,
      label: `Jour ${i + 1}`,
      dateLabel: dayDateLabel(key),
      color,
      traceIds,
      pointIndexes,
      mediaCount: mediaIndexes.length,
      videoCount,
    }
  })

  const undatedPointIndexes: number[] = []
  points.forEach((_, index) => {
    if (!pointDayKeys[index]) undatedPointIndexes.push(index)
  })

  return {
    days,
    pointDayKeys,
    pointDaySources,
    traceDayKeys,
    traceDaySources,
    undatedPointIndexes,
    multiDay: days.length >= 2,
  }
}

export const dayTraces = (day: TripDay, traces: Trace[]): Trace[] =>
  traces.filter((trace) => day.traceIds.includes(trace.id))

// Stats d'une journée : somme des traces du jour (comme les stats combinées
// globales : on ne compte pas l'écart entre la fin d'une trace et la suivante).
export const computeDayStats = (day: TripDay, traces: Trace[]): TrailStats => {
  let distanceMeters = 0
  let elevationGainMeters = 0
  let elevationLossMeters = 0
  let maxElevationMeters: number | null = null
  let minElevationMeters: number | null = null
  let pointCount = 0

  for (const trace of dayTraces(day, traces)) {
    const stats = computeTrailStats(trace.points)
    distanceMeters += stats.distanceMeters
    elevationGainMeters += stats.elevationGainMeters
    elevationLossMeters += stats.elevationLossMeters
    pointCount += stats.pointCount
    if (stats.maxElevationMeters !== null) {
      maxElevationMeters =
        maxElevationMeters === null
          ? stats.maxElevationMeters
          : Math.max(maxElevationMeters, stats.maxElevationMeters)
    }
    if (stats.minElevationMeters !== null) {
      minElevationMeters =
        minElevationMeters === null
          ? stats.minElevationMeters
          : Math.min(minElevationMeters, stats.minElevationMeters)
    }
  }

  return {
    distanceMeters,
    elevationGainMeters,
    elevationLossMeters,
    maxElevationMeters,
    minElevationMeters,
    pointCount,
  }
}
