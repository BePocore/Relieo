import type { TrackPoint, Trace, TrailProject } from '../types'

// =========================================================================
// Traces stockées en fichiers R2 (comme les médias), et non plus inline dans
// project.json : le JSON du projet reste petit quel que soit le nombre de
// points GPS (limite Vercel de ~4,5 Mo par requête), et la fidélité des
// traces est totale (aucune simplification).
//
// Format du fichier : JSON `{ version: 1, points: TrackPoint[] }`, rangé sous
// `<carte>/traces/<fingerprint>-<nom>.json`, servi par le videur avec le même
// ticket que les médias (et exempté de modération : ce n'est pas un média).
// =========================================================================

const TRACE_FILE_VERSION = 1

/** Sérialise les points d'une trace vers le fichier R2 (fidélité brute). */
export const serializeTracePoints = (points: TrackPoint[]): Blob => {
  return new Blob(
    [JSON.stringify({ version: TRACE_FILE_VERSION, points })],
    { type: 'application/json' },
  )
}

const isTrackPoint = (value: unknown): value is TrackPoint => {
  if (!value || typeof value !== 'object') return false
  const point = value as Record<string, unknown>
  return (
    typeof point.lat === 'number' &&
    Number.isFinite(point.lat) &&
    typeof point.lng === 'number' &&
    Number.isFinite(point.lng)
  )
}

/** Relit un fichier de trace R2. Renvoie null si le contenu est invalide. */
export const parseTraceFilePayload = (text: string): TrackPoint[] | null => {
  try {
    const parsed = JSON.parse(text) as { points?: unknown }
    if (!Array.isArray(parsed.points)) return null
    const points = parsed.points.filter(isTrackPoint)
    return points.length >= 2 ? points : null
  } catch {
    return null
  }
}

/** Empreinte SHA-256 (hex) d'un blob de trace, pour la déduplication R2. */
export const traceBlobFingerprint = async (blob: Blob): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Hydrate les traces d'un projet chargé : une trace au nouveau format (fileUrl,
 * pas de points inline) est récupérée depuis le videur (cookie ticket déjà posé
 * par requestMediaTicket) puis parsée. Les traces inline (anciennes cartes)
 * passent telles quelles. Une trace irrécupérable est ignorée (comptée dans
 * `missingCount`) plutôt que de bloquer toute la carte.
 */
export const hydrateProjectTraces = async (
  project: TrailProject,
): Promise<{ project: TrailProject; missingCount: number }> => {
  const rawTraces = project.traces
  if (!rawTraces || rawTraces.length === 0) {
    return { project, missingCount: 0 }
  }

  let missingCount = 0
  const hydrated = await Promise.all(
    rawTraces.map(async (trace): Promise<Trace | null> => {
      if (Array.isArray(trace.points) && trace.points.length > 1) {
        return trace
      }
      if (!trace.fileUrl) {
        missingCount += 1
        return null
      }
      try {
        const response = await fetch(trace.fileUrl, {
          credentials: 'include',
          cache: 'no-store',
        })
        if (!response.ok) {
          missingCount += 1
          return null
        }
        const points = parseTraceFilePayload(await response.text())
        if (!points) {
          missingCount += 1
          return null
        }
        return { ...trace, points }
      } catch {
        missingCount += 1
        return null
      }
    }),
  )

  return {
    project: {
      ...project,
      traces: hydrated.filter((trace): trace is Trace => trace !== null),
    },
    missingCount,
  }
}

/**
 * Forme stockée dans project.json : les métadonnées de chaque trace SANS ses
 * points (ils vivent dans le fichier R2 référencé par fileUrl).
 */
export const tracesForStorage = (traces: Trace[]): Trace[] =>
  traces.map((trace) => ({
    id: trace.id,
    name: trace.name,
    ...(trace.color ? { color: trace.color } : {}),
    ...(trace.fileUrl ? { fileUrl: trace.fileUrl } : {}),
    pointCount: trace.points.length,
    points: [],
  }))
