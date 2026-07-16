import type { TrackPoint, TrailStats } from '../types'
import { getIdToken } from './firebaseLazy'

export const LOCAL_TRACE_DRAFT_KEY = 'relieo.tracker.draft'

export type UserTraceRecord = {
  id: string
  name: string
  status?: 'recording' | 'interrupted' | 'saved'
  createdAt: string
  updatedAt: string
  autosavedAt?: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  points: TrackPoint[]
  stats: TrailStats
}

export const hasLocalTraceDraft = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return Boolean(window.localStorage.getItem(LOCAL_TRACE_DRAFT_KEY))
  } catch {
    return false
  }
}

type ApiError = {
  message?: string
}

const uploadApi = async <T>(body: unknown): Promise<T> => {
  const token = await getIdToken()
  if (!token) throw new Error('Connexion requise.')
  const response = await fetch('/api/upload', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const data = (await response.json().catch(() => null)) as ApiError | null
  if (!response.ok) {
    throw new Error(data?.message ?? 'Action trace impossible.')
  }
  return data as T
}

export const loadUserTraces = async (): Promise<UserTraceRecord[]> => {
  const data = await uploadApi<{ traces?: UserTraceRecord[] }>({
    type: 'relieo.list-user-traces',
  })
  return data.traces ?? []
}

export const saveUserTrace = async (
  trace: UserTraceRecord,
): Promise<UserTraceRecord> => {
  const data = await uploadApi<{ trace?: UserTraceRecord }>({
    type: 'relieo.save-user-trace',
    trace,
  })
  if (!data.trace) throw new Error('Trace non enregistree.')
  return data.trace
}

export const deleteUserTrace = async (traceId: string): Promise<void> => {
  await uploadApi<{ deleted?: boolean }>({
    type: 'relieo.delete-user-trace',
    traceId,
  })
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

export const traceToGpx = (trace: UserTraceRecord): string => {
  const points = trace.points
    .map((point) => {
      const ele = point.ele !== undefined ? `      <ele>${point.ele}</ele>\n` : ''
      const time = point.time ? `      <time>${xmlEscape(point.time)}</time>\n` : ''
      return `    <trkpt lat="${point.lat}" lon="${point.lng}">\n${ele}${time}    </trkpt>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Relieo" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xmlEscape(trace.name)}</name>
    <time>${xmlEscape(trace.createdAt)}</time>
  </metadata>
  <trk>
    <name>${xmlEscape(trace.name)}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`
}

export const downloadTraceGpx = (trace: UserTraceRecord): void => {
  const blob = new Blob([traceToGpx(trace)], {
    type: 'application/gpx+xml;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${trace.id}.gpx`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
