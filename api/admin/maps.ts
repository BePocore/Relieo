import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import { hasR2Config } from '../../server/r2.js'
import { readHikeIndex } from '../../server/hikeIndex.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// God-view : toutes les cartes de tous les utilisateurs (publiées + brouillons),
// enrichies de l'email du propriétaire pour l'affichage et l'ouverture Studio.
export async function GET(request: Request) {
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
    const [authList, hikes] = await Promise.all([
      getAuth(adminApp()).listUsers(1000),
      readHikeIndex(),
    ])
    const emailByUid = new Map<string, string | null>(
      authList.users.map((record) => [record.uid, record.email ?? null]),
    )

    const maps = hikes
      .map((hike) => ({
        ...hike,
        ownerEmail: hike.ownerId ? emailByUid.get(hike.ownerId) ?? null : null,
      }))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )

    return Response.json({ maps }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_MAPS_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture des cartes impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
