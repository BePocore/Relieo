import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import { hasR2Config, r2StorageUsage } from '../../server/r2.js'
import { readHikeIndex } from '../../server/hikeIndex.js'
import {
  R2_FREE_BYTES,
  monthlyR2Cost,
} from '../../server/plans.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Totaux du site pour le bandeau de stats admin + la vue Stockage R2.
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
    const [authList, hikes, totalBytes] = await Promise.all([
      getAuth(adminApp()).listUsers(1000),
      readHikeIndex(),
      r2StorageUsage(),
    ])

    const publishedCount = hikes.filter((h) => h.status === 'published').length

    return Response.json(
      {
        userCount: authList.users.length,
        hikeCount: hikes.length,
        publishedCount,
        draftCount: hikes.length - publishedCount,
        totalBytes,
        freeBytes: R2_FREE_BYTES,
        billableBytes: Math.max(0, totalBytes - R2_FREE_BYTES),
        monthlyCostEur: monthlyR2Cost(totalBytes, true),
      },
      { headers: jsonHeaders },
    )
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_OVERVIEW_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture des totaux impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
