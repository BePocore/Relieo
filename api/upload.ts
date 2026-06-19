import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import {
  hasR2Config,
  R2QuotaError,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
  r2KeyFromPublicUrl,
  r2ListKeys,
  r2PrepareUpload,
  r2PutText,
  type StorageScope,
} from '../server/r2.js'
import { cleanStorageName, STUDIO_OWNER, trailLocation, userStorageRoot } from '../server/trailStorage.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { readModeration } from '../server/moderation.js'
import { userStorageScope } from '../server/userStorage.js'
import { formatBytes } from '../server/format.js'

const allowedContentTypes = [
  'application/octet-stream',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
]

type PrepareUploadBody = {
  type: 'relieo.prepare-upload'
  fileName?: string
  contentType?: string
  fingerprint?: string
  kind?: 'media' | 'preview'
  size?: number
  trailCode?: string
}

type DeleteMediaBody = {
  type: 'relieo.delete-media'
  mediaUrl?: string
  thumbnailUrl?: string
  trailCode?: string
}

type CleanupUnusedMediaBody = {
  type: 'relieo.cleanup-unused-media'
  usedUrls?: string[]
  trailCode?: string
}

type ListUserTracesBody = {
  type: 'relieo.list-user-traces'
}

type SaveUserTraceBody = {
  type: 'relieo.save-user-trace'
  trace?: unknown
}

type DeleteUserTraceBody = {
  type: 'relieo.delete-user-trace'
  traceId?: string
}

type UploadBody =
  | PrepareUploadBody
  | DeleteMediaBody
  | CleanupUnusedMediaBody
  | ListUserTracesBody
  | SaveUserTraceBody
  | DeleteUserTraceBody

type StoredTracePoint = {
  lat: number
  lng: number
  ele?: number
  time?: string
}

type StoredTrailStats = {
  distanceMeters: number
  elevationGainMeters: number
  elevationLossMeters: number
  maxElevationMeters: number | null
  minElevationMeters: number | null
  pointCount: number
}

type StoredUserTrace = {
  id: string
  name: string
  status?: 'recording' | 'interrupted' | 'saved'
  createdAt: string
  updatedAt: string
  autosavedAt?: string
  startedAt: string
  endedAt: string
  durationSeconds: number
  points: StoredTracePoint[]
  stats: StoredTrailStats
}

const TRACE_POINT_LIMIT = 20_000
const earthRadiusMeters = 6_371_000

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

const distanceBetween = (from: StoredTracePoint, to: StoredTracePoint): number => {
  const lat1 = toRadians(from.lat)
  const lat2 = toRadians(to.lat)
  const deltaLat = toRadians(to.lat - from.lat)
  const deltaLng = toRadians(to.lng - from.lng)
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const normalizeTracePoint = (value: unknown): StoredTracePoint | null => {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (
    !finiteNumber(input.lat) ||
    !finiteNumber(input.lng) ||
    input.lat < -90 ||
    input.lat > 90 ||
    input.lng < -180 ||
    input.lng > 180
  ) {
    return null
  }
  const point: StoredTracePoint = {
    lat: input.lat,
    lng: input.lng,
  }
  if (finiteNumber(input.ele)) point.ele = input.ele
  if (typeof input.time === 'string' && Number.isFinite(Date.parse(input.time))) {
    point.time = new Date(input.time).toISOString()
  }
  return point
}

const computeTraceStats = (points: StoredTracePoint[]): StoredTrailStats => {
  let distanceMeters = 0
  let elevationGainMeters = 0
  let elevationLossMeters = 0
  let maxElevationMeters: number | null = null
  let minElevationMeters: number | null = null

  points.forEach((point, index) => {
    if (index > 0) {
      const previous = points[index - 1]
      distanceMeters += distanceBetween(previous, point)
      if (previous.ele !== undefined && point.ele !== undefined) {
        const diff = point.ele - previous.ele
        if (diff > 0.5) elevationGainMeters += diff
        if (diff < -0.5) elevationLossMeters += Math.abs(diff)
      }
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
    }
  })

  return {
    distanceMeters,
    elevationGainMeters,
    elevationLossMeters,
    maxElevationMeters,
    minElevationMeters,
    pointCount: points.length,
  }
}

const cleanTraceId = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  const id = cleanStorageName(value).slice(0, 80)
  return id === 'media' ? '' : id
}

const traceRoot = (owner: string): string => `${userStorageRoot(owner)}traces/`

const traceKey = (owner: string, traceId: string): string =>
  `${traceRoot(owner)}${traceId}/trace.json`

const tracePrefix = (owner: string, traceId: string): string =>
  `${traceRoot(owner)}${traceId}/`

const normalizeTraceRecord = (
  value: unknown,
  options?: { touchUpdatedAt?: boolean },
): StoredUserTrace => {
  if (!value || typeof value !== 'object') {
    throw new Error('Trace invalide.')
  }
  const input = value as Record<string, unknown>
  const rawPoints = Array.isArray(input.points) ? input.points : []
  if (rawPoints.length > TRACE_POINT_LIMIT) {
    throw new Error('Trace trop volumineuse.')
  }
  const points = rawPoints
    .map((point) => normalizeTracePoint(point))
    .filter((point): point is StoredTracePoint => Boolean(point))
  if (points.length < 2) {
    throw new Error('Trace trop courte.')
  }

  const now = new Date().toISOString()
  const id =
    cleanTraceId(input.id) ||
    `trace-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
  const name =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim().slice(0, 90)
      : 'Trace Relieo'
  const startedAt =
    typeof input.startedAt === 'string' && Number.isFinite(Date.parse(input.startedAt))
      ? new Date(input.startedAt).toISOString()
      : points[0].time ?? now
  const endedAt =
    typeof input.endedAt === 'string' && Number.isFinite(Date.parse(input.endedAt))
      ? new Date(input.endedAt).toISOString()
      : points[points.length - 1].time ?? now
  const fallbackDuration = Math.max(
    1,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000),
  )
  const durationSeconds = finiteNumber(input.durationSeconds)
    ? Math.max(1, Math.round(input.durationSeconds))
    : fallbackDuration
  const status =
    input.status === 'recording' ||
    input.status === 'interrupted' ||
    input.status === 'saved'
      ? input.status
      : 'saved'

  return {
    id,
    name,
    status,
    createdAt:
      typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt))
        ? new Date(input.createdAt).toISOString()
        : now,
    updatedAt:
      options?.touchUpdatedAt === false &&
      typeof input.updatedAt === 'string' &&
      Number.isFinite(Date.parse(input.updatedAt))
        ? new Date(input.updatedAt).toISOString()
        : now,
    autosavedAt:
      typeof input.autosavedAt === 'string' && Number.isFinite(Date.parse(input.autosavedAt))
        ? new Date(input.autosavedAt).toISOString()
        : status === 'recording' || status === 'interrupted'
          ? now
          : undefined,
    startedAt,
    endedAt,
    durationSeconds,
    points,
    stats: computeTraceStats(points),
  }
}

const parseStoredTrace = (raw: string | null): StoredUserTrace | null => {
  if (!raw) return null
  try {
    return normalizeTraceRecord(JSON.parse(raw), { touchUpdatedAt: false })
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: "Cloudflare R2 n'est pas configure." },
      { status: 503 },
    )
  }
  // Auth : jeton Firebase si configure, sinon mot de passe admin (compat).
  let uid: string | null = null
  if (hasFirebaseAdmin()) {
    const user = await verifyRequestUser(request)
    if (!user) {
      return Response.json({ message: 'Connexion requise.' }, { status: 401 })
    }
    uid = user.uid
  } else {
    if (!hasAdminPassword()) {
      return Response.json(
        { message: 'RANDO3D_ADMIN_PASSWORD manque dans Vercel.' },
        { status: 503 },
      )
    }
    if (!isAdminRequest(request)) {
      return Response.json(
        { message: 'Mot de passe Studio incorrect.' },
        { status: 401 },
      )
    }
  }

  // Un compte sanctionne (bloque ou supprime) ne peut plus rien envoyer.
  if (uid && (await readModeration(uid)).status !== 'active') {
    return Response.json(
      { message: 'Votre compte est suspendu.' },
      { status: 403 },
    )
  }

  try {
    const body = (await request.json()) as UploadBody
    if (
      body.type !== 'relieo.prepare-upload' &&
      body.type !== 'relieo.delete-media' &&
      body.type !== 'relieo.cleanup-unused-media' &&
      body.type !== 'relieo.list-user-traces' &&
      body.type !== 'relieo.save-user-trace' &&
      body.type !== 'relieo.delete-user-trace'
    ) {
      return Response.json({ message: 'Requete upload invalide.' }, { status: 400 })
    }

    // Le dossier de la rando est range sous le prefixe du proprietaire prouve
    // (uid Firebase), ou sous le namespace `_studio` pour le repli mot de passe
    // admin. Impossible donc d'ecrire dans le dossier d'un autre utilisateur.
    const owner = uid ?? STUDIO_OWNER

    if (body.type === 'relieo.list-user-traces') {
      const keys = await r2ListKeys(traceRoot(owner))
      const traceKeys = keys.filter((key) => key.endsWith('/trace.json'))
      const traces = (
        await Promise.all(
          traceKeys.map(async (key) => parseStoredTrace(await r2GetText(key))),
        )
      )
        .filter((trace): trace is StoredUserTrace => Boolean(trace))
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )

      return Response.json({ traces })
    }

    if (body.type === 'relieo.save-user-trace') {
      const trace = normalizeTraceRecord(body.trace)
      const scope: StorageScope | undefined = uid
        ? userStorageScope(uid)
        : undefined
      await r2PutText(traceKey(owner, trace.id), JSON.stringify(trace), scope)
      return Response.json({ trace })
    }

    if (body.type === 'relieo.delete-user-trace') {
      const id = cleanTraceId(body.traceId)
      if (!id) {
        return Response.json({ message: 'Trace introuvable.' }, { status: 400 })
      }
      await r2DeletePrefix(tracePrefix(owner, id))
      return Response.json({ deleted: true })
    }

    const location = trailLocation(owner, body.trailCode ?? '')

    if (body.type === 'relieo.delete-media') {
      const mediaKey = body.mediaUrl ? r2KeyFromPublicUrl(body.mediaUrl) : null
      const thumbnailKey = body.thumbnailUrl
        ? r2KeyFromPublicUrl(body.thumbnailUrl)
        : null

      if (!mediaKey || !mediaKey.startsWith(`${location.prefix}/media/`)) {
        return Response.json(
          { message: 'Media R2 introuvable pour cette carte.' },
          { status: 400 },
        )
      }
      if (
        thumbnailKey &&
        !thumbnailKey.startsWith(`${location.prefix}/previews/`)
      ) {
        return Response.json(
          { message: 'Apercu R2 introuvable pour cette carte.' },
          { status: 400 },
        )
      }

      await r2DeleteObject(mediaKey)
      if (thumbnailKey) await r2DeleteObject(thumbnailKey)
      return Response.json({ deleted: true })
    }

    if (body.type === 'relieo.cleanup-unused-media') {
      const allowedPrefixes = [
        `${location.prefix}/media/`,
        `${location.prefix}/previews/`,
      ]
      const usedKeys = new Set(
        (body.usedUrls ?? [])
          .map((url) => r2KeyFromPublicUrl(url))
          .filter((key): key is string =>
            Boolean(
              key &&
                allowedPrefixes.some((prefix) => key.startsWith(prefix)),
            ),
          ),
      )
      const [mediaKeys, previewKeys] = await Promise.all(
        allowedPrefixes.map((prefix) => r2ListKeys(prefix)),
      )
      const mediaKeysToDelete = mediaKeys.filter(
        (key) => !usedKeys.has(key),
      )
      const previewKeysToDelete = previewKeys.filter((key) => !usedKeys.has(key))
      const keysToDelete = [...mediaKeysToDelete, ...previewKeysToDelete]

      for (const key of keysToDelete) {
        await r2DeleteObject(key)
      }

      return Response.json({
        deletedCount: keysToDelete.length,
        mediaDeletedCount: mediaKeysToDelete.length,
        previewDeletedCount: previewKeysToDelete.length,
      })
    }

    const fingerprint = body.fingerprint?.replace(/[^a-f0-9]/gi, '')
    const contentType = body.contentType?.trim() || 'application/octet-stream'
    const size = Number(body.size)

    if (!fingerprint || fingerprint.length < 16) {
      return Response.json({ message: 'Empreinte de fichier invalide.' }, { status: 400 })
    }
    if (!allowedContentTypes.includes(contentType)) {
      return Response.json({ message: 'Type de fichier non autorise.' }, { status: 400 })
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      return Response.json({ message: 'Taille de fichier invalide.' }, { status: 400 })
    }

    const folder = body.kind === 'preview' ? 'previews' : 'media'
    const fileName = cleanStorageName(body.fileName ?? 'media')
    const suffix = body.kind === 'preview' ? `${fingerprint}.jpg` : `${fingerprint}-${fileName}`
    // Quota par utilisateur (5 Go) si on connait son uid ; sinon repli global.
    const scope: StorageScope | undefined = uid
      ? userStorageScope(uid)
      : undefined
    const prepared = await r2PrepareUpload({
      key: `${location.prefix}/${folder}/${suffix}`,
      contentType,
      size,
      scope,
    })
    return Response.json({ provider: 'r2', folder: location.folder, ...prepared })
  } catch (error) {
    if (error instanceof R2QuotaError) {
      return Response.json(
        {
          code: error.code,
          limitBytes: error.limitBytes,
          requestedBytes: error.requestedBytes,
          usedBytes: error.usedBytes,
          message: `Limite de ${formatBytes(error.limitBytes)} atteinte pour votre forfait. Le fichier n'a pas ete enregistre.`,
        },
        { status: 413 },
      )
    }
    return Response.json(
      {
        code: 'UPLOAD_FAILED',
        message: error instanceof Error ? error.message : 'Envoi R2 impossible.',
      },
      { status: 400 },
    )
  }
}
