import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import { readAllProfiles } from '../../server/firestoreAdmin.js'
import { hasR2Config, r2UsageForPrefixes } from '../../server/r2.js'
import { readHikeIndex } from '../../server/hikeIndex.js'
import { userStorageRoot } from '../../server/trailStorage.js'
import { DEFAULT_PLAN_ID, monthlyR2Cost } from '../../server/plans.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type AdminUser = {
  uid: string
  email: string | null
  name?: string
  plan: string
  createdAt: string | null
  emailVerified: boolean
  hikeCount: number
  publishedCount: number
  mediaCount: number
  usedBytes: number
  monthlyCostEur: number
}

// Vue admin des utilisateurs : chaque compte Firebase + son profil Firestore,
// son nombre de cartes/médias (registre R2) et son stockage réel + coût R2.
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
    const [authList, profiles, hikes] = await Promise.all([
      getAuth(adminApp()).listUsers(1000),
      readAllProfiles(),
      readHikeIndex(),
    ])

    // Agrégats par propriétaire depuis le registre des cartes.
    const byOwner = new Map<
      string,
      { hikeCount: number; publishedCount: number; mediaCount: number }
    >()
    for (const hike of hikes) {
      if (!hike.ownerId) continue
      const current = byOwner.get(hike.ownerId) ?? {
        hikeCount: 0,
        publishedCount: 0,
        mediaCount: 0,
      }
      current.hikeCount += 1
      if (hike.status === 'published') current.publishedCount += 1
      current.mediaCount += hike.mediaCount ?? 0
      byOwner.set(hike.ownerId, current)
    }

    const users: AdminUser[] = await Promise.all(
      authList.users.map(async (record) => {
        const profile = profiles.get(record.uid)
        const aggregate = byOwner.get(record.uid)
        const usedBytes = await r2UsageForPrefixes([
          userStorageRoot(record.uid),
        ])
        return {
          uid: record.uid,
          email: record.email ?? null,
          name: profile?.name ?? record.displayName ?? undefined,
          plan: profile?.plan ?? DEFAULT_PLAN_ID,
          createdAt: record.metadata.creationTime ?? null,
          emailVerified: record.emailVerified,
          hikeCount: aggregate?.hikeCount ?? 0,
          publishedCount: aggregate?.publishedCount ?? 0,
          mediaCount: aggregate?.mediaCount ?? 0,
          usedBytes,
          monthlyCostEur: monthlyR2Cost(usedBytes),
        }
      }),
    )

    users.sort((a, b) => b.usedBytes - a.usedBytes)
    return Response.json({ users }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_USERS_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture des utilisateurs impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
