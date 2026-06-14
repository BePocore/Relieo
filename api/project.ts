import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import {
  hasR2Config,
  R2QuotaError,
  r2CopyObjects,
  r2CopyPrefix,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
  r2KeyFromPublicUrl,
  r2PublicUrl,
  r2PutText,
} from '../server/r2.js'
import {
  activeTrailPath,
  cleanStorageName,
  legacyProjectPath,
  trailLocation,
  type ActiveTrail,
} from '../server/trailStorage.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type StoredMedia = {
  id?: string
  name?: string
  url?: string
  thumbnailUrl?: string
  fingerprint?: string
  kind?: 'image' | 'video'
}

type StoredPoint = {
  id?: string
  image?: string
  video?: string
  [key: string]: unknown
}

type StoredProject = {
  accessCode?: string
  mediaLibrary?: StoredMedia[]
  points: StoredPoint[]
  track: unknown[]
  [key: string]: unknown
}

const isProjectPayload = (value: unknown): value is StoredProject => {
  if (!value || typeof value !== 'object') return false
  const project = value as Record<string, unknown>
  return Array.isArray(project.track) && Array.isArray(project.points)
}

const readActiveTrail = async (): Promise<ActiveTrail | null> => {
  const body = await r2GetText(activeTrailPath)
  if (!body) return null
  try {
    const value = JSON.parse(body) as ActiveTrail
    return value?.projectKey && value?.prefix ? value : null
  } catch {
    return null
  }
}

const readPublishedProject = async (): Promise<string | null> => {
  const active = await readActiveTrail()
  if (active) return r2GetText(active.projectKey)
  return r2GetText(legacyProjectPath)
}

const storageTarget = (
  sourceUrl: string,
  target: ActiveTrail,
  folder: 'media' | 'previews',
  media: StoredMedia,
): { sourceKey: string; destinationKey: string; destinationUrl: string } => {
  const sourceKey = r2KeyFromPublicUrl(sourceUrl)
  if (!sourceKey) {
    throw new Error(
      `Le fichier ${media.name ?? media.id ?? 'sans nom'} n'est pas stocké dans Cloudflare R2. Réimporte-le avant de publier.`,
    )
  }

  const existingTrailMarker = '/media/'
  const existingPreviewMarker = '/previews/'
  const marker = folder === 'media' ? existingTrailMarker : existingPreviewMarker
  const markerIndex = sourceKey.indexOf(marker)
  const suffix =
    markerIndex >= 0
      ? sourceKey.slice(markerIndex + marker.length)
      : folder === 'previews'
        ? `${media.fingerprint ?? cleanStorageName(media.id ?? 'preview')}.jpg`
        : `${media.fingerprint ?? cleanStorageName(media.id ?? 'media')}-${cleanStorageName(media.name ?? 'media')}`
  const destinationKey = `${target.prefix}/${folder}/${suffix}`
  return {
    sourceKey,
    destinationKey,
    destinationUrl: r2PublicUrl(destinationKey),
  }
}

const moveProjectMedia = async (
  project: StoredProject,
  target: ActiveTrail,
): Promise<{ project: StoredProject; migratedSourceKeys: string[] }> => {
  const replacements = new Map<string, string>()
  const copies: Array<{ sourceKey: string; destinationKey: string }> = []
  const migratedSourceKeys: string[] = []

  const mediaLibrary = (project.mediaLibrary ?? []).map((media) => {
    if (!media.url || media.url.startsWith('blob:')) {
      throw new Error(
        `Le média ${media.name ?? media.id ?? 'sans nom'} n'a pas été envoyé sur Cloudflare R2. Réimporte-le avant de publier.`,
      )
    }
    const original = storageTarget(media.url, target, 'media', media)
    copies.push(original)
    replacements.set(media.url, original.destinationUrl)
    if (original.sourceKey !== original.destinationKey) {
      migratedSourceKeys.push(original.sourceKey)
    }

    let thumbnailUrl = media.thumbnailUrl
    if (thumbnailUrl) {
      const preview = storageTarget(thumbnailUrl, target, 'previews', media)
      copies.push(preview)
      replacements.set(thumbnailUrl, preview.destinationUrl)
      thumbnailUrl = preview.destinationUrl
      if (preview.sourceKey !== preview.destinationKey) {
        migratedSourceKeys.push(preview.sourceKey)
      }
    }

    return { ...media, url: original.destinationUrl, thumbnailUrl }
  })

  for (const point of project.points) {
    for (const field of ['image', 'video'] as const) {
      const sourceUrl = point[field]
      if (!sourceUrl || replacements.has(sourceUrl)) continue
      if (sourceUrl.startsWith('blob:')) {
        throw new Error(
          `Le fichier lié au point ${point.id ?? 'sans nom'} n'a pas été envoyé sur Cloudflare R2. Réimporte-le avant de publier.`,
        )
      }
      const sourceKey = r2KeyFromPublicUrl(sourceUrl)
      if (!sourceKey) {
        throw new Error(
          `Le fichier lié au point ${point.id ?? 'sans nom'} n'est pas dans Cloudflare R2. Réimporte-le avant de publier.`,
        )
      }
      const fileName = cleanStorageName(sourceKey.split('/').pop() ?? `${point.id ?? field}`)
      const destinationKey = sourceKey.startsWith(`${target.prefix}/`)
        ? sourceKey
        : `${target.prefix}/media/${fileName}`
      const destinationUrl = r2PublicUrl(destinationKey)
      copies.push({ sourceKey, destinationKey })
      replacements.set(sourceUrl, destinationUrl)
      if (sourceKey !== destinationKey) migratedSourceKeys.push(sourceKey)
    }
  }

  await r2CopyObjects(copies)

  const points = project.points.map((point) => ({
    ...point,
    ...(point.image && replacements.has(point.image)
      ? { image: replacements.get(point.image) }
      : {}),
    ...(point.video && replacements.has(point.video)
      ? { video: replacements.get(point.video) }
      : {}),
  }))

  return {
    project: { ...project, mediaLibrary, points },
    migratedSourceKeys: Array.from(new Set(migratedSourceKeys)),
  }
}

export async function GET() {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  try {
    const body = await readPublishedProject()
    if (!body) {
      return Response.json(
        { message: 'Aucune randonnée enregistrée dans Cloudflare R2.' },
        { status: 404, headers: jsonHeaders },
      )
    }
    return new Response(body, {
      headers: { ...jsonHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return Response.json(
      {
        code: 'STORAGE_READ_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture R2 impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}

export async function PUT(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  if (!hasAdminPassword()) {
    return Response.json(
      { message: 'RANDO3D_ADMIN_PASSWORD manque dans Vercel.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  if (!isAdminRequest(request)) {
    return Response.json(
      { message: 'Mot de passe Studio incorrect.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const payload = (await request.json()) as unknown
    if (!isProjectPayload(payload)) {
      return Response.json(
        { message: 'Données de randonnée invalides.' },
        { status: 400, headers: jsonHeaders },
      )
    }
    const code = payload.accessCode?.trim()
    if (!code) {
      return Response.json(
        { message: 'Le code de la randonnée est obligatoire pour son dossier R2.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const target = trailLocation(code)
    const previous = await readActiveTrail()

    // Copie d'abord l'ancien dossier. Il n'est supprimé qu'après la publication.
    if (previous && previous.prefix !== target.prefix) {
      await r2CopyPrefix(`${previous.prefix}/`, `${target.prefix}/`)
    }

    const migrated = await moveProjectMedia(payload, target)
    const body = JSON.stringify(migrated.project)
    if (body.length > 10_000_000) {
      return Response.json(
        { message: 'La randonnée dépasse la taille maximale autorisée.' },
        { status: 413, headers: jsonHeaders },
      )
    }

    const url = await r2PutText(target.projectKey, body)
    await r2PutText(activeTrailPath, JSON.stringify(target))

    // Le nouveau projet et le pointeur existent : l'ancien emplacement peut partir.
    if (previous && previous.prefix !== target.prefix) {
      await r2DeletePrefix(`${previous.prefix}/`)
    }
    for (const sourceKey of migrated.migratedSourceKeys) {
      if (!sourceKey.startsWith(`${target.prefix}/`)) {
        await r2DeleteObject(sourceKey)
      }
    }
    await r2DeleteObject(legacyProjectPath)

    return Response.json(
      {
        provider: 'r2',
        folder: target.folder,
        savedAt: target.updatedAt,
        url,
      },
      { headers: jsonHeaders },
    )
  } catch (error) {
    if (error instanceof R2QuotaError) {
      return Response.json(
        { code: error.code, message: 'Limite de 9,99 Go atteinte dans Cloudflare R2.' },
        { status: 413, headers: jsonHeaders },
      )
    }
    return Response.json(
      {
        code: 'STORAGE_WRITE_FAILED',
        message:
          error instanceof Error ? error.message : 'Sauvegarde R2 impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
