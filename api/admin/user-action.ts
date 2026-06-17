import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { isAdminUid, requireAdmin } from '../../server/admin.js'
import {
  hasR2Config,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
} from '../../server/r2.js'
import { removeOwnerFromIndex } from '../../server/hikeIndex.js'
import { pushUserNotification } from '../../server/firestoreAdmin.js'
import { readModeration, setModeration } from '../../server/moderation.js'
import { appendSanction } from '../../server/sanctions.js'
import { activeTrailPath, userStorageRoot } from '../../server/trailStorage.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type UserActionBody = {
  uid?: string
  action?: 'block' | 'unblock' | 'delete-account'
  message?: string
}

const emailOf = async (uid: string): Promise<string | null> => {
  try {
    return (await getAuth(adminApp()).getUser(uid)).email ?? null
  } catch {
    return null
  }
}

// Si la carte publique active appartient à l'un des dossiers retirés, on coupe
// le pointeur pour qu'elle disparaisse de la vue publique par défaut.
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

// Sanctions de compte : bloquer, débloquer, supprimer (après 3 bans).
export async function POST(request: Request) {
  if (!hasFirebaseAdmin() || !hasR2Config()) {
    return Response.json(
      { message: 'Firebase Admin et Cloudflare R2 sont requis.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  const admin = await requireAdmin(request)
  if (!admin) {
    return Response.json(
      { message: 'Accès réservé à l’administrateur.' },
      { status: 403, headers: jsonHeaders },
    )
  }

  try {
    const body = (await request.json()) as UserActionBody
    const uid = body.uid?.trim()
    const action = body.action
    const message = body.message?.trim() ?? ''
    if (
      !uid ||
      (action !== 'block' && action !== 'unblock' && action !== 'delete-account')
    ) {
      return Response.json(
        { message: 'uid et action (block|unblock|delete-account) sont obligatoires.' },
        { status: 400, headers: jsonHeaders },
      )
    }
    if (isAdminUid(uid)) {
      return Response.json(
        { message: 'Un administrateur ne peut pas être sanctionné.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const current = await readModeration(uid)
    const targetEmail = await emailOf(uid)

    const logSanction = async (
      act: 'block' | 'unblock' | 'delete-account',
    ): Promise<void> => {
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

    if (action === 'block') {
      if (!message) {
        return Response.json(
          { message: 'Un message d’explication est obligatoire pour bloquer.' },
          { status: 400, headers: jsonHeaders },
        )
      }
      await setModeration(uid, {
        status: 'blocked',
        message,
        banCount: current.banCount + 1,
        appeal: null,
      })
      await pushUserNotification(uid, {
        id: `${uid}-block-${Date.now()}`,
        type: 'block',
        message,
        createdAt: new Date().toISOString(),
      })
      await logSanction('block')
      return Response.json(
        { uid, action, status: 'blocked', banCount: current.banCount + 1 },
        { headers: jsonHeaders },
      )
    }

    if (action === 'unblock') {
      await setModeration(uid, { status: 'active', message: '', appeal: null })
      await logSanction('unblock')
      return Response.json({ uid, action, status: 'active' }, { headers: jsonHeaders })
    }

    // delete-account : possible seulement après 3 bannissements reçus.
    if (current.banCount < 3) {
      return Response.json(
        {
          message: `Suppression impossible : ${current.banCount}/3 bannissements reçus.`,
        },
        { status: 403, headers: jsonHeaders },
      )
    }
    // Efface tout le contenu R2 du propriétaire et ses cartes du registre.
    const removedFolders = await removeOwnerFromIndex(uid)
    await clearActiveIfRemoved(removedFolders)
    await r2DeletePrefix(userStorageRoot(uid))
    await setModeration(uid, { status: 'deleted', message, appeal: null })
    await pushUserNotification(uid, {
      id: `${uid}-del-${Date.now()}`,
      type: 'delete-account',
      message,
      createdAt: new Date().toISOString(),
    })
    await logSanction('delete-account')
    return Response.json({ uid, action, status: 'deleted' }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_USER_ACTION_FAILED',
        message:
          error instanceof Error ? error.message : 'Action sur le compte impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
