import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import {
  hasR2Config,
  R2QuotaError,
  r2CopyObjects,
  r2GetText,
  r2KeyFromPublicUrl,
  r2PublicUrl,
  r2PutText,
  rewriteMediaUrls,
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
import { readHikeIndex, upsertHikeIndex } from '../server/hikeIndex.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { isAdminUser } from '../server/admin.js'
import { readModeration } from '../server/moderation.js'
import {
  filterServableMedia,
  moderationEnforced,
  readBlockedIds,
  readScannedIds,
} from '../server/mediaModeration.js'
import { userStorageScope } from '../server/userStorage.js'
import { formatBytes } from '../server/format.js'
import { pickRandomCoverUrl } from '../server/cover.js'
import { recordHikeView } from '../server/stats.js'

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
    if (code) {
      const folder = trailFolder(code)
      const entry = (await readHikeIndex()).find(
        (hike) => hike.folder === folder,
      )
      if (!entry) {
        return Response.json(
          { message: 'Aucune carte enregistrée pour ce code.' },
          { status: 404, headers: jsonHeaders },
        )
      }
      // On décode l'appelant une seule fois si on en a besoin : pour autoriser un
      // brouillon, et/ou pour savoir si on doit filtrer les médias non validés (le
      // propriétaire et l'admin voient tout, le visiteur public non).
      const needsViewer = entry.status === 'draft' || moderationEnforced()
      const viewer = needsViewer ? await verifyRequestUser(request) : null
      const isOwnerOrAdmin = Boolean(
        viewer && (viewer.uid === entry.ownerId || isAdminUser(viewer)),
      )
      // Brouillon : consultation réservée au propriétaire et à l'admin. On
      // renvoie 404 (et pas 403) pour ne pas révéler l'existence du brouillon.
      if (entry.status === 'draft' && !isOwnerOrAdmin) {
        return Response.json(
          { message: 'Aucune carte enregistrée pour ce code.' },
          { status: 404, headers: jsonHeaders },
        )
      }
      const body = await r2GetText(trailLocation(entry.ownerId, code).projectKey)
      if (!body) {
        return Response.json(
          { message: 'Aucune randonnée enregistrée dans Cloudflare R2.' },
          { status: 404, headers: jsonHeaders },
        )
      }
      // Comptage de vue : une carte PUBLIÉE consultée par un NON-propriétaire.
      // Best-effort (recordHikeView avale ses erreurs, jamais de blocage de la
      // consultation). L'exclusion du propriétaire repose sur isOwnerOrAdmin,
      // fiable tant que la modération force le décodage du jeton (cas prod
      // MODERATION_ENFORCE=1) ; sinon une vue du propriétaire pourrait compter.
      if (entry.status === 'published' && !isOwnerOrAdmin) {
        await recordHikeView(folder)
      }
      // Médias servis via le videur media.relieo.fr (réécriture à la volée), en
      // consultation publique COMME en Studio. La sauvegarde reconvertit les URLs
      // en clé R2 (`r2KeyFromPublicUrl` accepte media.relieo.fr), donc rien n'est
      // figé côté stockage (project.json garde des clés/URLs r2.dev).
      const served = rewriteMediaUrls(body)
      // Le statut fiable vient de l'index : une dépublication via le tableau de
      // bord ne réécrit pas project.json. On l'injecte pour que le client
      // connaisse l'état réel (publiée / brouillon).
      try {
        let project = JSON.parse(served) as Record<string, unknown>
        // Modération (couche 2) : pour un VISITEUR public, on retire les médias
        // non encore validés ou flaggés (le videur les refuserait de toute façon).
        // Le propriétaire/admin garde tout. No-op tant que MODERATION_ENFORCE≠1.
        if (moderationEnforced() && !isOwnerOrAdmin) {
          const [scanned, blocked] = await Promise.all([
            readScannedIds(),
            readBlockedIds(),
          ])
          project = filterServableMedia(project, scanned, blocked)
        }
        return Response.json(
          { ...project, hikeStatus: entry.status },
          { headers: jsonHeaders },
        )
      } catch {
        return new Response(served, {
          headers: { ...jsonHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // Vue publique par défaut : la carte active. On lit `active.json` ici (plutôt
    // que via un helper) pour récupérer son `folder` et compter la vue sans
    // relire le fichier.
    const active = await readActiveTrail()
    const body = active
      ? await r2GetText(active.projectKey)
      : await r2GetText(legacyProjectPath)
    if (!body) {
      return Response.json(
        { message: 'Aucune randonnée enregistrée dans Cloudflare R2.' },
        { status: 404, headers: jsonHeaders },
      )
    }
    // La vue par défaut est toujours publique (le propriétaire passe par ?code=
    // ou le Studio) → on compte la vue, best-effort.
    if (active?.folder) await recordHikeView(active.folder)
    // Vue publique par défaut : médias servis via le videur media.relieo.fr. Cette
    // vue est toujours « publique » (le propriétaire passe par ?code= ou le Studio),
    // donc on filtre les médias non validés si la modération est active.
    let served = rewriteMediaUrls(body)
    if (moderationEnforced()) {
      try {
        const [scanned, blocked] = await Promise.all([
          readScannedIds(),
          readBlockedIds(),
        ])
        served = JSON.stringify(
          filterServableMedia(JSON.parse(served), scanned, blocked),
        )
      } catch {
        // project.json illisible : on sert tel quel (le videur reste la barrière).
      }
    }
    return new Response(served, {
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

  // Un compte sanctionné (bloqué ou supprimé) ne peut plus sauvegarder.
  if (authedUser && (await readModeration(authedUser.uid)).status !== 'active') {
    return Response.json(
      { message: 'Votre compte est suspendu.' },
      { status: 403, headers: jsonHeaders },
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

    // Entrée existante (le folder ne dépend que du code, pas du propriétaire).
    const existing = (await readHikeIndex()).find(
      (hike) => hike.folder === trailFolder(code),
    )

    // Accès Dieu : un admin édite « à la place » du vrai propriétaire. L'écriture
    // se fait alors sous le préfixe du propriétaire d'origine (la propriété ne
    // change pas). Sinon, propriétaire = l'appelant (ou `_studio` en repli).
    const isAdmin = isAdminUser(authedUser)
    const owner =
      isAdmin && existing?.ownerId
        ? existing.ownerId
        : authedUser?.uid ?? STUDIO_OWNER
    const target = trailLocation(owner, code)

    // Garde de propriété (levée pour l'admin) : on ne peut pas écraser la rando
    // d'un autre utilisateur.
    if (
      !isAdmin &&
      authedUser &&
      existing?.ownerId &&
      existing.ownerId !== authedUser.uid
    ) {
      return Response.json(
        { message: 'Cette randonnée appartient à un autre utilisateur.' },
        { status: 403, headers: jsonHeaders },
      )
    }

    // Statut : brouillon ou publiée (par défaut publiée pour compat ascendante).
    const status: 'draft' | 'published' =
      (payload as Record<string, unknown>).hikeStatus === 'draft'
        ? 'draft'
        : 'published'

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
    // dans le quota du PROPRIÉTAIRE (même quand un admin édite à sa place).
    const scope =
      owner === STUDIO_OWNER ? undefined : userStorageScope(owner)
    const url = await r2PutText(target.projectKey, body, scope)

    // Pointeur public : uniquement pour une carte PUBLIÉE (un brouillon ne doit
    // jamais devenir la carte publique par défaut). On ne l'initialise que s'il
    // n'existe pas encore ; s'il existe déjà (Halsa), on n'y touche pas.
    if (status === 'published') {
      const active = await readActiveTrail()
      if (!active) {
        await r2PutText(activeTrailPath, JSON.stringify(target))
      }
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
      // Propriété préservée : l'ownerId reste celui du propriétaire d'origine
      // (jamais l'admin), ou l'appelant pour une nouvelle carte.
      ownerId: owner !== STUDIO_OWNER ? owner : asString(meta.ownerId),
      title: asString(meta.title) ?? target.code,
      status,
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
