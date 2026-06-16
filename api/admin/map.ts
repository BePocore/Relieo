import { hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
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
import {
  activeTrailPath,
  trailFolder,
  trailLocation,
} from '../../server/trailStorage.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type MapActionBody = { code?: string; action?: 'unpublish' | 'delete' }

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

    if (action === 'unpublish') {
      await upsertHikeIndex({ folder, status: 'draft' })
      await clearActiveIfMatches(folder)
      return Response.json({ code, action, status: 'draft' }, { headers: jsonHeaders })
    }

    // delete : registre + dossier R2 du vrai propriétaire + pointeur public.
    await removeHikeIndex(folder)
    await clearActiveIfMatches(folder)
    if (owner) {
      await r2DeletePrefix(`${trailLocation(owner, code).prefix}/`)
    }
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
