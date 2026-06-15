import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import {
  hasR2Config,
  R2QuotaError,
  r2CopyObjects,
  r2GetText,
  r2KeyFromPublicUrl,
  r2PublicUrl,
  r2PutText,
} from '../server/r2.js'
import {
  activeTrailPath,
  cleanStorageName,
  legacyProjectPath,
  STUDIO_OWNER,
  trailFolder,
  trailLocation,
  type ActiveTrail,
} from '../server/trailStorage.js'
import {
  ownerForFolder,
  readHikeIndex,
  upsertHikeIndex,
} from '../server/hikeIndex.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { userStorageScope } from '../server/userStorage.js'
import { formatBytes } from '../server/format.js'
import { pickRandomCoverUrl } from '../server/cover.js'

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

export async function GET(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  try {
    // `?code=<code>` → cette randonnée précise. Sans code → la rando active
    // (consultation publique inchangée). La clé de stockage étant désormais
    // rangée sous le préfixe du propriétaire, on résout son uid via l'index.
    const code = new URL(request.url).searchParams.get('code')?.trim()
    const owner = code ? await ownerForFolder(trailFolder(code)) : null
    const body =
      code && owner
        ? await r2GetText(trailLocation(owner, code).projectKey)
        : code
          ? null
          : await readPublishedProject()
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
  // Auth : si Firebase est configuré, on exige un jeton Firebase valide (le
  // propriétaire est alors PROUVÉ). Sinon, repli sur le mot de passe admin.
  const authedUser = await verifyRequestUser(request)
  if (hasFirebaseAdmin()) {
    if (!authedUser) {
      return Response.json(
        { message: 'Connexion requise.' },
        { status: 401, headers: jsonHeaders },
      )
    }
  } else {
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

    // Propriétaire prouvé (uid Firebase) ou repli `_studio` (mode admin dev).
    const owner = authedUser?.uid ?? STUDIO_OWNER
    const target = trailLocation(owner, code)

    // Garde de propriété : on ne peut pas écraser la rando d'un autre utilisateur.
    const existing = (await readHikeIndex()).find(
      (hike) => hike.folder === target.folder,
    )
    if (authedUser && existing?.ownerId && existing.ownerId !== authedUser.uid) {
      return Response.json(
        { message: 'Cette randonnée appartient à un autre utilisateur.' },
        { status: 403, headers: jsonHeaders },
      )
    }

    // Multi-rando : chaque randonnée vit dans son propre dossier. On n'écrase et
    // ne supprime JAMAIS les autres randos (Halsa et toute rando déjà publiée
    // restent intactes). Les médias sont déjà rangés dans le dossier de la rando
    // par l'upload ; moveProjectMedia ne fait que rapatrier d'éventuels restes.
    const migrated = await moveProjectMedia(payload, target)
    const body = JSON.stringify(migrated.project)
    if (body.length > 10_000_000) {
      return Response.json(
        { message: 'La randonnée dépasse la taille maximale autorisée.' },
        { status: 413, headers: jsonHeaders },
      )
    }

    // La fiche project.json est rangée dans le dossier de la rando : elle compte
    // dans le quota du propriétaire (5 Go) quand on connaît son uid.
    const scope = authedUser ? userStorageScope(authedUser.uid) : undefined
    const url = await r2PutText(target.projectKey, body, scope)

    // Pointeur public : on l'initialise seulement s'il n'existe pas encore.
    // S'il existe déjà (Halsa), on n'y touche pas → la rando publique ne change pas.
    const active = await readActiveTrail()
    if (!active) {
      await r2PutText(activeTrailPath, JSON.stringify(target))
    }

    // Registre des randos : insert/maj de cette entrée uniquement.
    const meta = payload as Record<string, unknown>
    const asNumber = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined
    await upsertHikeIndex({
      code: target.code,
      folder: target.folder,
      ownerId: authedUser?.uid ?? asString(meta.ownerId),
      title: asString(meta.title) ?? target.code,
      status: meta.hikeStatus === 'draft' ? 'draft' : 'published',
      distanceKm: asNumber(meta.distanceKm),
      elevationGain: asNumber(meta.elevationGain),
      pointCount: asNumber(meta.pointCount) ?? migrated.project.points.length,
      mediaCount:
        asNumber(meta.mediaCount) ?? (migrated.project.mediaLibrary?.length ?? 0),
      // Cover : celle fournie, sinon une image au hasard de la carte.
      coverUrl: asString(meta.coverUrl) ?? pickRandomCoverUrl(migrated.project),
      updatedAt: target.updatedAt,
    })

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
        {
          code: error.code,
          message: `Limite de ${formatBytes(error.limitBytes)} atteinte pour votre forfait.`,
        },
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
