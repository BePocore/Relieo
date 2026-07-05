import type { TrackPoint, TrailStats } from '../types'

const earthRadiusMeters = 6_371_000

const toRadians = (degrees: number): number => {
  return (degrees * Math.PI) / 180
}

export const distanceBetween = (from: TrackPoint, to: TrackPoint): number => {
  const lat1 = toRadians(from.lat)
  const lat2 = toRadians(to.lat)
  const deltaLat = toRadians(to.lat - from.lat)
  const deltaLng = toRadians(to.lng - from.lng)

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

type ProjectedPoint = {
  x: number
  y: number
}

const squaredDistanceToSegment = (
  point: ProjectedPoint,
  start: ProjectedPoint,
  end: ProjectedPoint,
): number => {
  const dx = end.x - start.x
  const dy = end.y - start.y

  if (dx === 0 && dy === 0) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2
  }

  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  )
  const closestX = start.x + ratio * dx
  const closestY = start.y + ratio * dy

  return (point.x - closestX) ** 2 + (point.y - closestY) ** 2
}

export const simplifyTrack = (
  track: TrackPoint[],
  toleranceMeters = 3,
  maxPoints = 3_000,
): TrackPoint[] => {
  if (track.length <= 2) return track

  const referenceLatitude = toRadians(
    track.reduce((sum, point) => sum + point.lat, 0) / track.length,
  )
  const projected = track.map<ProjectedPoint>((point) => ({
    x: earthRadiusMeters * toRadians(point.lng) * Math.cos(referenceLatitude),
    y: earthRadiusMeters * toRadians(point.lat),
  }))
  const keep = new Uint8Array(track.length)
  const stack: Array<[number, number]> = [[0, track.length - 1]]
  const toleranceSquared = toleranceMeters ** 2
  keep[0] = 1
  keep[track.length - 1] = 1

  while (stack.length > 0) {
    const segment = stack.pop()
    if (!segment) break

    const [startIndex, endIndex] = segment
    let farthestIndex = -1
    let farthestDistance = toleranceSquared

    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = squaredDistanceToSegment(
        projected[index],
        projected[startIndex],
        projected[endIndex],
      )

      if (distance > farthestDistance) {
        farthestDistance = distance
        farthestIndex = index
      }
    }

    if (farthestIndex !== -1) {
      keep[farthestIndex] = 1
      stack.push([startIndex, farthestIndex], [farthestIndex, endIndex])
    }
  }

  const simplified = track.filter((_, index) => keep[index] === 1)
  if (simplified.length <= maxPoints) return simplified

  const stride = Math.ceil((simplified.length - 2) / (maxPoints - 2))
  return simplified.filter(
    (_, index) =>
      index === 0 ||
      index === simplified.length - 1 ||
      (index - 1) % stride === 0,
  )
}

// Seuil d'hystérésis du dénivelé : une variation d'altitude n'est comptée que
// lorsqu'elle CUMULE plus que ce seuil depuis la dernière altitude confirmée
// (le bruit GPS de quelques mètres est ignoré), mais elle est alors comptée EN
// ENTIER. L'ancien calcul point à point (seuil 0,5 m PAR échantillon) perdait
// presque toute une montée régulière sur une trace dense (1 pt/s ≈ 0,3 m par
// point, systématiquement sous le seuil) : D+ très sous-estimé.
const ELEVATION_HYSTERESIS_METERS = 3

export const computeTrailStats = (track: TrackPoint[]): TrailStats => {
  let distanceMeters = 0
  let elevationGainMeters = 0
  let elevationLossMeters = 0
  let maxElevationMeters: number | null = null
  let minElevationMeters: number | null = null
  // Altitude « ancre » de l'hystérésis : dernier niveau confirmé.
  let anchorElevation: number | null = null

  track.forEach((point, index) => {
    if (index > 0) {
      distanceMeters += distanceBetween(track[index - 1], point)
    }

    if (point.ele !== undefined) {
      maxElevationMeters =
        maxElevationMeters === null
          ? point.ele
          : Math.max(maxElevationMeters, point.ele)
      minElevationMeters =
        minElevationMeters === null
          ? point.ele
          : Math.min(minElevationMeters, point.ele)

      if (anchorElevation === null) {
        anchorElevation = point.ele
      } else {
        const diff = point.ele - anchorElevation
        if (diff >= ELEVATION_HYSTERESIS_METERS) {
          elevationGainMeters += diff
          anchorElevation = point.ele
        } else if (diff <= -ELEVATION_HYSTERESIS_METERS) {
          elevationLossMeters += -diff
          anchorElevation = point.ele
        }
      }
    }
  })

  return {
    distanceMeters,
    elevationGainMeters,
    elevationLossMeters,
    maxElevationMeters,
    minElevationMeters,
    pointCount: track.length,
  }
}

export const nearestElevation = (
  target: Pick<TrackPoint, 'lat' | 'lng'>,
  track: TrackPoint[],
): number | undefined => {
  const nearest = track.reduce<{
    point: TrackPoint | null
    distance: number
  }>(
    (best, point) => {
      const distance = distanceBetween(target, point)
      return distance < best.distance ? { point, distance } : best
    },
    { point: null, distance: Number.POSITIVE_INFINITY },
  )

  return nearest.point?.ele
}
