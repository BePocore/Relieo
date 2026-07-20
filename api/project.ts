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
  STUDIO_OWNER,
  trailFolder,
  trailLocation,
  type ActiveTrail,
} from '../server/trailStorage.js'
import {
  readHikeIndex,
  resolveHikeEntry,
  upsertHikeIndex,
  type HikeIndexEntry,
} from '../server/hikeIndex.js'
import { syncPublicCover } from '../server/publicCovers.js'
import { syncOgMeta } from '../server/ogMeta.js'
import {
  hashAccessCode,
  TICKET_COOKIE,
  verifyTicket,
} from '../server/mediaTicket.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { isAdminUser } from '../server/admin.js'
import { readModeration } from '../server/moderation.js'
import {
  collectUnservableMedia,
  filterServableMedia,
  moderationEnforced,
  readBlockedIds,
  readScannedIds,
} from '../server/mediaModeration.js'
import { userMapLimit, userStorageScope } from '../server/userStorage.js'
import { readProfilePlan } from '../server/firestoreAdmin.js'
import { formatBytes } from '../server/format.js'
import { pickRandomCoverUrl } from '../server/cover.js'
import {
  isTutorialEvent,
  recordHikeView,
  recordTutorialEvent,
} from '../server/stats.js'
import {
  isHealthEventType,
  recordHealthEvent,
  recordHealthTiming,
} from '../server/health.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type StoredMedia = {
  id?: string
  name?: string
  url?: string
  thumbnailUrl?: string
  displayUrl?: string
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

// Lecture d'un cookie brut dans l'en-tête `Cookie` de la requête.
const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

// Le visiteur a-t-il une PREUVE D'ACCÈS pour cette carte ? = un cookie ticket
// média valide dont le préfixe couvre le dossier de la carte. Une carte
// protégée n'a un ticket que si /api/media-ticket a validé son code d'accès.
const hasValidGrant = async (
  request: Request,
  entry: HikeIndexEntry,
): Promise<boolean> => {
  const secret = process.env.MEDIA_TICKET_SECRET
  if (!secret) return false
  const token = readCookie(request, TICKET_COOKIE)
  if (!token) return false
  const payload = await verifyTicket(token, secret)
  if (!payload) return false
  const cardPrefix = `${trailLocation(entry.ownerId, entry.folder).prefix}/`
  // Ticket carte = ce préfixe exact ; ticket user/all = préfixe plus large.
  return cardPrefix.startsWith(payload.prefix)
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
  folder: 'media' | 'previews' | 'displays',
  media: StoredMedia,
): { sourceKey: string; destinationKey: string; destinationUrl: string } => {
  const sourceKey = r2KeyFromPublicUrl(sourceUrl)
  if (!sourceKey) {
    throw new Error(
      `Le fichier ${media.name ?? media.id ?? 'sans nom'} n'est pas stocké dans Cloudflare R2. Réimporte-le avant de publier.`,
    )
  }

  const marker =
    folder === 'media'
      ? '/media/'
      : folder === 'previews'
        ? '/previews/'
        : '/displays/'
  const markerIndex = sourceKey.indexOf(marker)
  const suffix =
    markerIndex >= 0
      ? sourceKey.slice(markerIndex + marker.length)
      : folder === 'previews' || folder === 'displays'
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

    let displayUrl = media.displayUrl
    if (displayUrl) {
      const display = storageTarget(displayUrl, target, 'displays', media)
      copies.push(display)
      replacements.set(displayUrl, display.destinationUrl)
      displayUrl = display.destinationUrl
      if (display.sourceKey !== display.destinationKey) {
        migratedSourceKeys.push(display.sourceKey)
      }
    }

    return { ...media, url: original.destinationUrl, thumbnailUrl, displayUrl }
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

/**
 * Mesure du tuto de consultation ET monitoring santé client (visiteur ANONYME).
 *
 * Hébergé ici, et non sur une route dédiée, parce que la limite de 12 fonctions
 * serverless du plan Vercel Hobby est atteinte : un handler de plus dans un
 * fichier existant ne coûte aucune fonction.
 *
 * Ne lit rien, n'expose rien, n'authentifie personne : il ne fait qu'incrémenter
 * des compteurs agrégés (aucun identifiant visiteur n'est reçu ni stocké).
 * Comme `recordHikeView`, c'est un endpoint public : n'importe qui peut le
 * solliciter, donc les chiffres sont indicatifs, pas de la comptabilité.
 *
 * `action: 'health'` (2026-07-20) : erreurs JS / voile bloqué / temps de
 * chargement réel, cf. server/health.ts pour le pourquoi.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: unknown
      event?: unknown
      step?: unknown
      kind?: unknown
      type?: unknown
      route?: unknown
      message?: unknown
      stack?: unknown
      detail?: unknown
      ms?: unknown
      connection?: unknown
      outcome?: unknown
    }

    if (body?.action === 'tuto') {
      if (!isTutorialEvent(body.event)) {
        return Response.json(
          { message: 'Requête inconnue.' },
          { status: 400, headers: jsonHeaders },
        )
      }
      await recordTutorialEvent(
        body.event,
        typeof body.step === 'string' ? body.step : '',
      )
      return new Response(null, { status: 204 })
    }

    if (body?.action === 'health') {
      if (body.kind === 'timing') {
        await recordHealthTiming({
          ms: body.ms,
          route: body.route,
          connection: body.connection,
          outcome: body.outcome,
        })
      } else if (isHealthEventType(body.type)) {
        await recordHealthEvent(body.type, {
          route: body.route,
          message: body.message,
          stack: body.stack,
          detail: body.detail,
        })
      }
      return new Response(null, { status: 204 })
    }

    return Response.json(
      { message: 'Requête inconnue.' },
      { status: 400, headers: jsonHeaders },
    )
  } catch {
    return Response.json(
      { message: 'Requête invalide.' },
      { status: 400, headers: jsonHeaders },
    )
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
    // Identifiant d'URL : `?m=<slug>` (schéma opaque) ou `?code=<code>` (legacy).
    // Sans identifiant → carte active par défaut. On résout toujours vers une
    // entrée d'index, dont le `folder` donne la clé de stockage.
    const url = new URL(request.url)
    const idParam = (
      url.searchParams.get('m') ?? url.searchParams.get('code')
    )?.trim()

    let entry: HikeIndexEntry | null = idParam
      ? await resolveHikeEntry(idParam)
      : null
    if (!idParam) {
      const active = await readActiveTrail()
      if (active?.folder) {
        entry =
          (await readHikeIndex()).find(
            (hike) => hike.folder === active.folder,
          ) ?? null
      }
    }
    if (!entry) {
      return Response.json(
        { message: 'Aucune carte enregistrée pour ce code.' },
        { status: 404, headers: jsonHeaders },
      )
    }

    // Décodage de l'appelant : le propriétaire et l'admin voient tout (contenu
    // complet, pas de porte de code, médias non filtrés).
    const viewer = await verifyRequestUser(request)
    const isOwnerOrAdmin = Boolean(
      viewer && (viewer.uid === entry.ownerId || isAdminUser(viewer)),
    )

    // Brouillon : réservé au propriétaire/admin. 404 (pas 403) pour ne pas
    // révéler l'existence du brouillon.
    if (entry.status === 'draft' && !isOwnerOrAdmin) {
      return Response.json(
        { message: 'Aucune carte enregistrée pour ce code.' },
        { status: 404, headers: jsonHeaders },
      )
    }

    const slug = entry.slug ?? entry.folder
    // PORTE DE CODE (Type 1) : une carte protégée ne livre RIEN de son contenu
    // au visiteur tant qu'il n'a pas de preuve d'accès (ticket valide, obtenu en
    // validant le code via /api/media-ticket). On renvoie juste des métadonnées
    // pour afficher l'écran de saisie.
    if (
      entry.accessCodeHash &&
      !isOwnerOrAdmin &&
      !(await hasValidGrant(request, entry))
    ) {
      return Response.json(
        {
          protected: true,
          slug,
          title: entry.title,
          coverUrl: entry.coverUrl,
          hikeStatus: entry.status,
        },
        { headers: jsonHeaders },
      )
    }

    const body = await r2GetText(
      trailLocation(entry.ownerId, entry.folder).projectKey,
    )
    if (!body) {
      return Response.json(
        { message: 'Aucune randonnée enregistrée dans Cloudflare R2.' },
        { status: 404, headers: jsonHeaders },
      )
    }
    // Comptage de vue : carte PUBLIÉE consultée par un NON-propriétaire.
    if (entry.status === 'published' && !isOwnerOrAdmin) {
      await recordHikeView(entry.folder)
    }
    // Médias servis via le videur media.relieo.fr (réécriture à la volée).
    const served = rewriteMediaUrls(body)
    try {
      let project = JSON.parse(served) as Record<string, unknown>
      // On ne renvoie JAMAIS le code d'accès (il n'est plus stocké en clair,
      // mais on nettoie par sécurité les project.json historiques).
      delete project.accessCode
      // Modération : pour un VISITEUR public, on retire les médias non validés /
      // flaggés (le videur les refuserait de toute façon). Pour le PROPRIÉTAIRE /
      // admin, on ne masque rien mais on signale les médias en attente pour le
      // badge « vérification en cours » du studio.
      let moderationPending: string[] = []
      if (moderationEnforced()) {
        const [scanned, blocked] = await Promise.all([
          readScannedIds(),
          readBlockedIds(),
        ])
        if (isOwnerOrAdmin) {
          moderationPending = collectUnservableMedia(project, scanned, blocked)
        } else {
          project = filterServableMedia(project, scanned, blocked)
        }
      }
      return Response.json(
        {
          ...project,
          hikeStatus: entry.status,
          slug,
          folder: entry.folder,
          // Visibilité de la carte (pour le toggle du studio) : protégée = un
          // code d'accès est en place.
          isProtected: Boolean(entry.accessCodeHash),
          moderationPending,
        },
        { headers: jsonHeaders },
      )
    } catch {
      return new Response(served, {
        headers: { ...jsonHeaders, 'Content-Type': 'application/json' },
      })
    }
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

  // Un compte sanctionné (bloqué/supprimé) OU dont les envois sont gelés ne
  // peut plus sauvegarder.
  if (authedUser) {
    const mod = await readModeration(authedUser.uid)
    if (mod.status !== 'active') {
      return Response.json(
        { message: 'Votre compte est suspendu.' },
        { status: 403, headers: jsonHeaders },
      )
    }
    if (mod.uploadsFrozen) {
      return Response.json(
        { message: 'Vos envois de contenu sont temporairement suspendus.' },
        { status: 403, headers: jsonHeaders },
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
    // Identité = le slug opaque (nouveau schéma). Le code d'accès n'est PLUS
    // l'identité : il arrive à part dans `accessCode` (secret write-only).
    const meta = payload as Record<string, unknown>
    const slugRaw = typeof meta.slug === 'string' ? meta.slug.trim() : ''
    if (!slugRaw) {
      return Response.json(
        { message: "L'identifiant de la carte est requis." },
        { status: 400, headers: jsonHeaders },
      )
    }

    // Entrée existante : par slug, sinon par folder (rétrocompat).
    const existing = await resolveHikeEntry(slugRaw)
    const canonicalSlug = existing?.slug ?? slugRaw

    // Accès Dieu : un admin édite « à la place » du vrai propriétaire. L'écriture
    // se fait alors sous le préfixe du propriétaire d'origine (la propriété ne
    // change pas). Sinon, propriétaire = l'appelant (ou `_studio` en repli).
    const isAdmin = isAdminUser(authedUser)
    const owner =
      isAdmin && existing?.ownerId
        ? existing.ownerId
        : authedUser?.uid ?? STUDIO_OWNER
    // Dossier de stockage STABLE : celui de l'entrée existante (ex. « Halsa »),
    // sinon dérivé du slug pour une nouvelle carte (folder = slug).
    const folder = existing?.folder ?? trailFolder(slugRaw)
    const target: ActiveTrail = {
      ...trailLocation(owner, folder),
      code: canonicalSlug,
    }

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

    // Limite de cartes du forfait : ne s'applique qu'à la CRÉATION d'une
    // nouvelle carte par un vrai utilisateur (pas l'admin god-mode). Le gratuit
    // est plafonné (3), les payants et comptes maison sont illimités. On compte
    // TOUTES ses cartes (brouillons + publiées) via l'index.
    if (!existing && authedUser && !isAdmin) {
      const plan = await readProfilePlan(authedUser.uid)
      const maxMaps = userMapLimit(authedUser.uid, authedUser.email, plan)
      if (Number.isFinite(maxMaps)) {
        const ownedCount = (await readHikeIndex()).filter(
          (entry) => entry.ownerId === authedUser.uid,
        ).length
        if (ownedCount >= maxMaps) {
          return Response.json(
            {
              code: 'MAP_LIMIT_REACHED',
              message: `Votre forfait est limité à ${maxMaps} cartes. Passez à un forfait supérieur pour en créer davantage.`,
            },
            { status: 403, headers: jsonHeaders },
          )
        }
      }
    }

    // Statut : brouillon ou publiée (par défaut publiée pour compat ascendante).
    const status: 'draft' | 'published' =
      meta.hikeStatus === 'draft' ? 'draft' : 'published'

    // Visibilité explicite : `accessMode: 'public'` rend la carte publique
    // (efface tout code d'accès). Absent → comportement historique (carte
    // privée : on garde ou on remplace le code selon `accessCode`).
    const makePublic = meta.accessMode === 'public'
    // Code d'accès SECRET (write-only) : s'il est fourni, on (re)calcule son
    // empreinte salée par le slug ; sinon on conserve celle en place. Jamais
    // stocké en clair. `null` = effacer (carte publique).
    const submittedCode =
      typeof meta.accessCode === 'string' ? meta.accessCode.trim() : ''
    const accessCodeHash: string | null | undefined = makePublic
      ? null
      : submittedCode
        ? await hashAccessCode(submittedCode, canonicalSlug)
        : existing?.accessCodeHash

    // On ne persiste JAMAIS le code d'accès ni le slug dans project.json.
    const toStore = { ...payload }
    delete toStore.accessCode
    delete (toStore as Record<string, unknown>).slug

    // Multi-rando : chaque randonnée vit dans son propre dossier. On n'écrase et
    // ne supprime JAMAIS les autres randos (Halsa et toute rando déjà publiée
    // restent intactes). Les médias sont déjà rangés dans le dossier de la rando
    // par l'upload ; moveProjectMedia ne fait que rapatrier d'éventuels restes.
    const migrated = await moveProjectMedia(toStore, target)
    const body = JSON.stringify(migrated.project)
    if (body.length > 10_000_000) {
      return Response.json(
        { message: 'La randonnée dépasse la taille maximale autorisée.' },
        { status: 413, headers: jsonHeaders },
      )
    }

    // La fiche project.json est rangée dans le dossier de la rando : elle compte
    // dans le quota du PROPRIÉTAIRE (selon SON forfait, même quand un admin
    // édite à sa place).
    const ownerPlan =
      owner === STUDIO_OWNER ? undefined : await readProfilePlan(owner)
    const scope =
      owner === STUDIO_OWNER
        ? undefined
        : userStorageScope(owner, undefined, ownerPlan)
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
    const asNumber = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined
    const asString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined
    // Cover : celle fournie, sinon une image au hasard de la carte.
    const coverUrl = asString(meta.coverUrl) ?? pickRandomCoverUrl(migrated.project)
    await upsertHikeIndex({
      code: target.code,
      folder: target.folder,
      slug: canonicalSlug,
      accessCodeHash,
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
      coverUrl,
      updatedAt: target.updatedAt,
    })

    // Couverture publique (feed social) : miroir rafraîchi quand la carte est
    // publiée (best-effort, ne bloque pas la sauvegarde).
    await syncPublicCover(
      { slug: canonicalSlug, status, coverUrl },
      { force: true },
    )

    // Métadonnées d'aperçu (Open Graph) : le projet complet est ici, donc on a
    // le lieu (placeName des points) et le nombre de médias pour la description.
    await syncOgMeta({
      slug: canonicalSlug,
      status,
      title: asString(meta.title) ?? target.code,
      points: migrated.project.points,
      mediaCount:
        asNumber(meta.mediaCount) ?? (migrated.project.mediaLibrary?.length ?? 0),
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
