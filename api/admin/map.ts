import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import {
  hasR2Config,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
} from '../../server/r2.js'
import {
  ownerForFolder,
  removeHikeIndex,
  upsertHikeIndex,
} from '../../server/hikeIndex.js'
import { pushUserNotification } from '../../server/firestoreAdmin.js'
import { appendSanction, type SanctionAction } from '../../server/sanctions.js'
import {
  activeTrailPath,
  trailFolder,
  trailLocation,
} from '../../server/trailStorage.js'

// Email du propriétaire au moment de l'action (pour un journal autonome).
const ownerEmail = async (uid: string | null): Promise<string | null> => {
  if (!uid) return null
  try {
    return (await getAuth(adminApp()).getUser(uid)).email ?? null
  } catch {
    return null
  }
}

const jsonHeaders = { 'Cache-Control': 'no-store' }

type MapActionBody = {
  code?: string
  action?: 'unpublish' | 'delete'
  // Message facultatif transmis au propriétaire à sa prochaine connexion.
  message?: string
  title?: string
}

// Si la carte ciblée est la carte publique active, on retire le pointeur pour
// qu'elle disparaisse de la vue publique par défaut.
const clearActiveIfMatches = async (folder: string): Promise<void> => {
  const body = await r2GetText(activeTrailPath)
  if (!body) return
  try {
    const active = JSON.parse(body) as { folder?: string }
    if (active?.folder === folder) await r2DeleteObject(activeTrailPath)
  } catch {
    // active.json illisible : on n'y touche pas.
  }
}

// Modération admin d'une carte : dépublier (repasse en brouillon) ou supprimer
// (retire du registre + efface le dossier R2 du propriétaire).
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
    const body = (await request.json()) as MapActionBody
    const code = body.code?.trim()
    const action = body.action
    if (!code || (action !== 'unpublish' && action !== 'delete')) {
      return Response.json(
        { message: 'code et action (unpublish|delete) sont obligatoires.' },
        { status: 400, headers: jsonHeaders },
      )
    }
    const folder = trailFolder(code)
    const owner = await ownerForFolder(folder)
    const mapTitle = body.title?.trim() || code
    const message = body.message?.trim() ?? ''

    // Trace l'action dans le journal de modération (toujours, message ou non).
    const logSanction = async (act: SanctionAction): Promise<void> => {
      await appendSanction({
        id: `${folder}-${Date.now()}`,
        action: act,
        mapCode: code,
        mapTitle,
        ownerId: owner ?? '',
        ownerEmail: await ownerEmail(owner),
        adminUid: admin.uid,
        adminEmail: admin.email,
        message,
        createdAt: new Date().toISOString(),
      })
    }

    if (action === 'unpublish') {
      await upsertHikeIndex({ folder, status: 'draft' })
      await clearActiveIfMatches(folder)
      // Notifie le propriétaire (message admin affiché à sa prochaine connexion).
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
      return Response.json({ code, action, status: 'draft' }, { headers: jsonHeaders })
    }

    // delete : registre + dossier R2 du vrai propriétaire + pointeur public.
    await removeHikeIndex(folder)
    await clearActiveIfMatches(folder)
    if (owner) {
      await r2DeletePrefix(`${trailLocation(owner, code).prefix}/`)
    }
    // Notifie le propriétaire (message admin affiché à sa prochaine connexion).
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
    return Response.json({ code, action, deleted: true }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_MAP_ACTION_FAILED',
        message:
          error instanceof Error ? error.message : 'Action sur la carte impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
