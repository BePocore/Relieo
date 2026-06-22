import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { isAdminUid, requireAdmin } from '../../server/admin.js'
import {
  hasR2Config,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
  r2KeyFromPublicUrl,
  r2PutText,
} from '../../server/r2.js'
import {
  ownerForFolder,
  readHikeIndex,
  removeHikeIndex,
  removeOwnerFromIndex,
  upsertHikeIndex,
} from '../../server/hikeIndex.js'
import {
  appendModerationHistory,
  approveModerationItem,
  autoRejectThreshold,
  moderationEnforced,
  moderationSignalConfigured,
  readModerationItems as readMediaModerationItems,
  rejectModerationItems,
  triggerModerationScan,
} from '../../server/mediaModeration.js'
import { pushUserNotification, setUserPlan } from '../../server/firestoreAdmin.js'
import { readModeration, setModeration } from '../../server/moderation.js'
import { appendSanction } from '../../server/sanctions.js'
import {
  markAdminNotificationsRead,
  setAdminNotificationReply,
} from '../../server/adminNotifications.js'
import {
  activeTrailPath,
  trailFolder,
  trailLocation,
  userStorageRoot,
} from '../../server/trailStorage.js'
import { PLAN_STORAGE_LIMITS } from '../../server/plans.js'
import { emailConfigured, sendEmail } from '../../server/email.js'
import { moderationEmailHtml } from '../../server/emailTemplates.js'
import type { AuthedUser } from '../../server/firebaseAdmin.js'
import type {
  MediaModerationDecision,
  MediaModerationEntry,
} from '../../server/mediaModeration.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type ActionBody = {
  action?:
    | 'set-plan'
    | 'map'
    | 'user-action'
    | 'reply-appeal'
    | 'mark-read'
    | 'media-mod'
    | 'scan-media'
  // set-plan
  plan?: string
  // map + user-action + reply-appeal
  uid?: string
  code?: string
  op?: string
  message?: string
  title?: string
  // mark-read + reply-appeal (notification visée)
  ids?: string[]
  notifId?: string
  // media-mod (clé R2 du média flaggé)
  id?: string
}

// uid/folder extraits d'une clé R2 `relieo/users/<uid>/randonnees/<folder>/…`.
const segmentAfter = (key: string, marker: string): string | null => {
  const parts = key.split('/')
  const index = parts.indexOf(marker)
  return index >= 0 && index + 1 < parts.length ? parts[index + 1] || null : null
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: jsonHeaders })

const emailOf = async (uid: string | null): Promise<string | null> => {
  if (!uid) return null
  try {
    return (await getAuth(adminApp()).getUser(uid)).email ?? null
  } catch {
    return null
  }
}

const mediaKindFromKey = (key: string): 'image' | 'video' =>
  /\.(mp4|mov|webm|mkv|avi|m4v|3gp)$/i.test(key) ? 'video' : 'image'

const appendMediaModerationDecision = async (
  decision: MediaModerationDecision,
  entries: MediaModerationEntry[],
  mediaIds: string[],
  reviewer: { uid: string; email: string | null },
  message: string,
): Promise<void> => {
  const ids = [...new Set(mediaIds.filter(Boolean))]
  const primary = entries[0]
  const firstId = primary?.id ?? ids[0] ?? ''
  if (!firstId) return
  const scoreItem = entries.reduce<MediaModerationEntry | null>(
    (best, item) => (!best || item.aiScore > best.aiScore ? item : best),
    null,
  )

  await appendModerationHistory({
    id: `media-${decision}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    decision,
    mediaIds: ids.length ? ids : [firstId],
    ownerUid: primary?.ownerUid ?? segmentAfter(firstId, 'users') ?? '',
    mapFolder: primary?.mapFolder ?? segmentAfter(firstId, 'randonnees') ?? '',
    mediaKind: primary?.mediaKind ?? mediaKindFromKey(firstId),
    aiCategory: scoreItem?.aiCategory ?? '',
    aiScore: typeof scoreItem?.aiScore === 'number' ? scoreItem.aiScore : 0,
    decidedAt: new Date().toISOString(),
    decidedBy: reviewer.uid,
    decidedByEmail: reviewer.email,
    message,
    source: reviewer.uid === 'ai-auto' ? 'auto' : 'admin',
  })
}

// Double une notification de modération in-app par un email (si un fournisseur
// est configuré et qu'on a l'adresse). Best-effort : ne bloque jamais l'action.
const notifyByEmail = async (
  to: string | null,
  heading: string,
  message: string,
  mapTitle?: string,
): Promise<void> => {
  if (!to || !message || !emailConfigured()) return
  await sendEmail({
    to,
    subject: heading,
    html: moderationEmailHtml(heading, message, mapTitle),
  })
}

// Coupe le pointeur public si la carte active fait partie des dossiers visés.
const clearActiveIfRemoved = async (folders: string[]): Promise<void> => {
  if (folders.length === 0) return
  const body = await r2GetText(activeTrailPath)
  if (!body) return
  try {
    const active = JSON.parse(body) as { folder?: string }
    if (active?.folder && folders.includes(active.folder)) {
      await r2DeleteObject(activeTrailPath)
    }
  } catch {
    // active.json illisible : on n'y touche pas.
  }
}

// --- Modération d'une carte (dépublier / supprimer) ---
const handleMap = async (admin: AuthedUser, body: ActionBody) => {
  const code = body.code?.trim()
  const op = body.op
  if (!code || (op !== 'unpublish' && op !== 'delete')) {
    return json({ message: 'code et op (unpublish|delete) sont obligatoires.' }, 400)
  }
  const folder = trailFolder(code)
  const owner = await ownerForFolder(folder)
  const ownerEmail = await emailOf(owner)
  const mapTitle = body.title?.trim() || code
  const message = body.message?.trim() ?? ''

  const logSanction = async (act: 'unpublish' | 'delete') => {
    await appendSanction({
      id: `${folder}-${Date.now()}`,
      action: act,
      mapCode: code,
      mapTitle,
      ownerId: owner ?? '',
      ownerEmail,
      adminUid: admin.uid,
      adminEmail: admin.email,
      message,
      createdAt: new Date().toISOString(),
    })
  }

  if (op === 'unpublish') {
    await upsertHikeIndex({ folder, status: 'draft' })
    await clearActiveIfRemoved([folder])
    if (owner && message) {
      await pushUserNotification(owner, {
        id: `${folder}-${Date.now()}`,
        type: 'unpublish',
        message,
        mapTitle,
        createdAt: new Date().toISOString(),
      })
      await notifyByEmail(ownerEmail, 'Votre carte a été dépubliée', message, mapTitle)
    }
    await logSanction('unpublish')
    return json({ code, op, status: 'draft' })
  }

  await removeHikeIndex(folder)
  await clearActiveIfRemoved([folder])
  if (owner) await r2DeletePrefix(`${trailLocation(owner, code).prefix}/`)
  if (owner && message) {
    await pushUserNotification(owner, {
      id: `${folder}-${Date.now()}`,
      type: 'delete',
      message,
      mapTitle,
      createdAt: new Date().toISOString(),
    })
    await notifyByEmail(ownerEmail, 'Votre carte a été supprimée', message, mapTitle)
  }
  await logSanction('delete')
  return json({ code, op, deleted: true })
}

// --- Modération d'un compte (bloquer / débloquer / supprimer) ---
const handleUserAction = async (admin: AuthedUser, body: ActionBody) => {
  const uid = body.uid?.trim()
  const op = body.op
  const message = body.message?.trim() ?? ''
  if (
    !uid ||
    (op !== 'block' &&
      op !== 'unblock' &&
      op !== 'delete-account' &&
      op !== 'dismiss-deletion-request')
  ) {
    return json(
      {
        message:
          'uid et op (block|unblock|delete-account|dismiss-deletion-request) sont obligatoires.',
      },
      400,
    )
  }
  if (isAdminUid(uid)) {
    return json({ message: 'Un administrateur ne peut pas être sanctionné.' }, 400)
  }

  const current = await readModeration(uid)
  const targetEmail = await emailOf(uid)
  const logSanction = async (act: 'block' | 'unblock' | 'delete-account') => {
    await appendSanction({
      id: `${uid}-${Date.now()}`,
      action: act,
      mapCode: '',
      mapTitle: '',
      ownerId: uid,
      ownerEmail: targetEmail,
      targetUid: uid,
      targetEmail,
      adminUid: admin.uid,
      adminEmail: admin.email,
      message,
      createdAt: new Date().toISOString(),
    })
  }

  if (op === 'block') {
    if (!message) {
      return json({ message: 'Un message d’explication est obligatoire pour bloquer.' }, 400)
    }
    await setModeration(uid, {
      status: 'blocked',
      message,
      banCount: current.banCount + 1,
      appeal: null,
      adminReply: null,
    })
    await pushUserNotification(uid, {
      id: `${uid}-block-${Date.now()}`,
      type: 'block',
      message,
      createdAt: new Date().toISOString(),
    })
    await notifyByEmail(targetEmail, 'Votre compte Relieo a été bloqué', message)
    await logSanction('block')
    return json({ uid, op, status: 'blocked', banCount: current.banCount + 1 })
  }

  if (op === 'unblock') {
    await setModeration(uid, {
      status: 'active',
      message: '',
      appeal: null,
      adminReply: null,
    })
    await logSanction('unblock')
    return json({ uid, op, status: 'active' })
  }

  if (op === 'dismiss-deletion-request') {
    await setModeration(uid, { deletionRequest: null })
    if (body.notifId) await markAdminNotificationsRead([body.notifId])
    return json({ uid, op, dismissed: true })
  }

  // delete-account : après 3 bannissements OU sur demande volontaire de l'utilisateur.
  const fromRequest = Boolean(current.deletionRequest)
  if (current.banCount < 3 && !fromRequest) {
    return json(
      { message: `Suppression impossible : ${current.banCount}/3 bannissements reçus.` },
      403,
    )
  }
  const removedFolders = await removeOwnerFromIndex(uid)
  await clearActiveIfRemoved(removedFolders)
  await r2DeletePrefix(userStorageRoot(uid))
  await setModeration(uid, {
    status: 'deleted',
    message,
    appeal: null,
    deletionRequest: null,
    email: targetEmail,
    deletedAt: new Date().toISOString(),
    deletedBy: admin.email ?? admin.uid,
  })
  if (fromRequest) {
    // Suppression volontaire : on supprime l'auth Firebase pour libérer l'email
    // (l'utilisateur pourra se réinscrire). La trace reste dans `moderation`.
    await getAuth(adminApp()).deleteUser(uid)
  } else {
    // Suppression après bannissements : l'auth est conservée (désactivée à la
    // reconnexion via finalize-deletion), l'email reste réservé.
    await pushUserNotification(uid, {
      id: `${uid}-del-${Date.now()}`,
      type: 'delete-account',
      message,
      createdAt: new Date().toISOString(),
    })
    await notifyByEmail(targetEmail, 'Votre compte Relieo a été supprimé', message)
  }
  if (body.notifId) await markAdminNotificationsRead([body.notifId])
  await logSanction('delete-account')
  return json({ uid, op, status: 'deleted' })
}

// --- Modération IA d'un média (approuver / rejeter) ---
const handleMediaMod = async (admin: AuthedUser, body: ActionBody) => {
  const id = body.id?.trim()
  const op = body.op
  const ids = Array.isArray(body.ids)
    ? body.ids
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
    : []
  const targetIds = ids.length > 0 ? ids : id ? [id] : []

  if (targetIds.length === 0 || (op !== 'approve' && op !== 'reject')) {
    return json({ message: 'id et op (approve|reject) sont obligatoires.' }, 400)
  }

  // Approuver : l'IA s'est trompée. On retire l'entrée -> le média redevient
  // servable (il reste « scanné »). Aucune suppression.
  if (op === 'approve') {
    const approvedEntries: MediaModerationEntry[] = []
    for (const targetId of targetIds) {
      const entry = await approveModerationItem(targetId)
      if (entry) approvedEntries.push(entry)
    }
    await appendMediaModerationDecision(
      'approved',
      approvedEntries,
      approvedEntries.map((entry) => entry.id),
      { uid: admin.uid, email: admin.email },
      '',
    )
    return json({ ids: targetIds, op, approved: true })
  }

  // Rejeter : non conforme. Cœur factorisé (réutilisé par l'auto-suppression).
  await rejectMediaCore(targetIds[0], { uid: admin.uid, email: admin.email }, body.message?.trim() ?? '')
  return json({ id: targetIds[0], op, rejected: true })
}

// Cœur du rejet d'un média, partagé par le bouton « Rejeter » (manuel) et la
// suppression automatique (score >= seuil auto). Résout la carte via l'index,
// retire le média (original + sa vignette) du project.json et de R2, marque rejeté,
// notifie le propriétaire (in-app + email best-effort) et journalise la sanction.
// Renvoie les clés R2 effacées (pour dédupliquer original/vignette en auto).
const rejectMediaCore = async (
  id: string,
  reviewer: { uid: string; email: string | null },
  message: string,
): Promise<Set<string>> => {
  const moderationItems = await readMediaModerationItems()
  const entry = moderationItems.find((item) => item.id === id)
  const folder = entry?.mapFolder || segmentAfter(id, 'randonnees') || ''
  const hike = folder
    ? (await readHikeIndex()).find((item) => item.folder === folder)
    : undefined
  const ownerUid = hike?.ownerId || entry?.ownerUid || segmentAfter(id, 'users') || ''
  const code = hike?.code || folder || ''
  const mapTitle = hike?.title || code || 'votre carte'

  // Couple de clés à effacer : la clé flaggée + l'original et la vignette du même
  // média (le flag peut viser l'un OU l'autre des deux objets scannés).
  const keysToDelete = new Set<string>([id])
  let originalKey: string | null = null

  if (ownerUid && code) {
    const projectKey = trailLocation(ownerUid, code).projectKey
    const raw = await r2GetText(projectKey)
    if (raw) {
      try {
        const project = JSON.parse(raw) as {
          mediaLibrary?: Array<{ url?: string; thumbnailUrl?: string }>
          points?: Array<{ image?: string; video?: string }>
          [key: string]: unknown
        }
        const library = Array.isArray(project.mediaLibrary) ? project.mediaLibrary : []
        const target = library.find((media) => {
          const oKey = media.url ? r2KeyFromPublicUrl(media.url) : null
          const tKey = media.thumbnailUrl ? r2KeyFromPublicUrl(media.thumbnailUrl) : null
          return oKey === id || tKey === id
        })
        if (target) {
          originalKey = target.url ? r2KeyFromPublicUrl(target.url) : null
          const thumbKey = target.thumbnailUrl
            ? r2KeyFromPublicUrl(target.thumbnailUrl)
            : null
          if (originalKey) keysToDelete.add(originalKey)
          if (thumbKey) keysToDelete.add(thumbKey)
          const nextLibrary = library.filter((media) => media !== target)
          const nextPoints = (
            Array.isArray(project.points) ? project.points : []
          ).filter((point) => {
            const iKey = point.image ? r2KeyFromPublicUrl(point.image) : null
            const vKey = point.video ? r2KeyFromPublicUrl(point.video) : null
            return iKey !== originalKey && vKey !== originalKey
          })
          await r2PutText(
            projectKey,
            JSON.stringify({ ...project, mediaLibrary: nextLibrary, points: nextPoints }),
            undefined,
            { skipQuota: true },
          )
        }
      } catch {
        // project.json illisible : on supprime au moins la clé connue.
      }
    }
  }

  // Bloque définitivement (rejeté) puis efface les octets de R2.
  await rejectModerationItems([...keysToDelete], reviewer.uid)
  for (const key of keysToDelete) await r2DeleteObject(key)

  // Notifie le propriétaire (in-app + email best-effort) et journalise la sanction.
  const ownerEmail = await emailOf(ownerUid || null)
  if (ownerUid && message) {
    await pushUserNotification(ownerUid, {
      id: `media-${Date.now()}`,
      type: 'media-rejected',
      message,
      mapTitle,
      createdAt: new Date().toISOString(),
    })
    await notifyByEmail(ownerEmail, 'Un de vos médias a été retiré', message, mapTitle)
  }
  await appendSanction({
    id: `media-${Date.now()}`,
    action: 'media-reject',
    mapCode: code,
    mapTitle,
    ownerId: ownerUid,
    ownerEmail,
    adminUid: reviewer.uid,
    adminEmail: reviewer.email,
    message,
    createdAt: new Date().toISOString(),
  })
  const relatedEntries = moderationItems.filter((item) => keysToDelete.has(item.id))
  await appendMediaModerationDecision(
    'rejected',
    relatedEntries.length > 0 ? relatedEntries : entry ? [entry] : [],
    [...keysToDelete],
    reviewer,
    message,
  )
  return keysToDelete
}

// Suppression automatique des cas évidents : tout média signalé dont le score
// dépasse le seuil auto est rejeté sans revue. Gated sur enforce=1 (en rodage on
// observe, on ne supprime rien). Renvoie le nombre de médias auto-supprimés.
const autoRejectFlaggedMedia = async (): Promise<number> => {
  if (!moderationEnforced()) return 0
  const threshold = autoRejectThreshold()
  const done = new Set<string>()
  let removed = 0
  for (const item of await readMediaModerationItems()) {
    if (item.status !== 'flagged' || (item.aiScore ?? 0) < threshold) continue
    if (done.has(item.id)) continue
    const pct = Math.round((item.aiScore ?? 0) * 100)
    const deleted = await rejectMediaCore(
      item.id,
      { uid: 'ai-auto', email: null },
      `Média retiré automatiquement par la modération (${item.aiCategory}, confiance ${pct}%).`,
    )
    deleted.forEach((key) => done.add(key))
    removed += 1
  }
  return removed
}

// Endpoint admin unique pour TOUTES les écritures (anciens `set-plan`, `map`,
// `user-action`, et le marquage-lu des notifications). Aiguille sur `action`.
export async function POST(request: Request) {
  if (!hasFirebaseAdmin() || !hasR2Config()) {
    return json({ message: 'Firebase Admin et Cloudflare R2 sont requis.' }, 503)
  }
  const admin = await requireAdmin(request)
  if (!admin) {
    return json({ message: 'Accès réservé à l’administrateur.' }, 403)
  }

  try {
    const body = (await request.json()) as ActionBody
    switch (body.action) {
      case 'set-plan': {
        const uid = body.uid?.trim()
        const plan = body.plan?.trim()
        if (!uid || !plan) return json({ message: 'uid et plan sont obligatoires.' }, 400)
        if (!(plan in PLAN_STORAGE_LIMITS)) {
          return json({ message: `Forfait inconnu : ${plan}.` }, 400)
        }
        await setUserPlan(uid, plan)
        return json({ uid, plan })
      }
      case 'map':
        return handleMap(admin, body)
      case 'user-action':
        return handleUserAction(admin, body)
      case 'media-mod':
        return handleMediaMod(admin, body)
      case 'scan-media': {
        // Bouton « Lancer un scan » : déclenche un passage immédiat dans le videur
        // et renvoie son rapport (null tant que la modération n'est pas configurée),
        // puis auto-supprime les cas évidents (>= seuil auto) si enforce=1.
        const report = await triggerModerationScan()
        const autoRemoved = await autoRejectFlaggedMedia()
        // `configured` distingue « pas de modération » d'un simple timeout du scan.
        return json({ report, autoRemoved, configured: moderationSignalConfigured() })
      }
      case 'reply-appeal': {
        const notifId = body.notifId?.trim()
        const message = body.message?.trim()
        if (!notifId || !message) {
          return json({ message: 'notifId et message sont obligatoires.' }, 400)
        }
        // La réponse est attachée à CETTE notification (par appel).
        const uid = await setAdminNotificationReply(notifId, message)
        // Si l'appel correspond au bannissement EN COURS, on l'affiche aussi à
        // l'utilisateur sur son écran de blocage (moderation.adminReply).
        if (uid) {
          const current = await readModeration(uid)
          if (current.status === 'blocked' && current.appeal?.notifId === notifId) {
            await setModeration(uid, {
              adminReply: { message, sentAt: new Date().toISOString() },
            })
          }
        }
        return json({ notifId, replied: true })
      }
      case 'mark-read': {
        const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : []
        if (ids.length > 0) await markAdminNotificationsRead(ids)
        return json({ ok: true })
      }
      default:
        return json({ message: 'action inconnue.' }, 400)
    }
  } catch (error) {
    return json(
      {
        code: 'ADMIN_ACTION_FAILED',
        message: error instanceof Error ? error.message : 'Action impossible.',
      },
      500,
    )
  }
}
