import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { isAdminUid, requireAdmin } from '../../server/admin.js'
import {
  hasR2Config,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
} from '../../server/r2.js'
import {
  ownerForFolder,
  removeHikeIndex,
  removeOwnerFromIndex,
  upsertHikeIndex,
} from '../../server/hikeIndex.js'
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
import type { AuthedUser } from '../../server/firebaseAdmin.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type ActionBody = {
  action?: 'set-plan' | 'map' | 'user-action' | 'reply-appeal' | 'mark-read'
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
  const mapTitle = body.title?.trim() || code
  const message = body.message?.trim() ?? ''

  const logSanction = async (act: 'unpublish' | 'delete') => {
    await appendSanction({
      id: `${folder}-${Date.now()}`,
      action: act,
      mapCode: code,
      mapTitle,
      ownerId: owner ?? '',
      ownerEmail: await emailOf(owner),
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
  }
  if (body.notifId) await markAdminNotificationsRead([body.notifId])
  await logSanction('delete-account')
  return json({ uid, op, status: 'deleted' })
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
