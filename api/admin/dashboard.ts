import { getAuth } from 'firebase-admin/auth'
import { adminApp, hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { isAdminUid, requireAdmin } from '../../server/admin.js'
import {
  hasR2Config,
  r2StorageUsage,
  r2UsageForPrefixes,
} from '../../server/r2.js'
import { readHikeIndex } from '../../server/hikeIndex.js'
import { readAllProfiles } from '../../server/firestoreAdmin.js'
import { readAllModeration } from '../../server/moderation.js'
import { readSanctions } from '../../server/sanctions.js'
import { readAdminNotifications } from '../../server/adminNotifications.js'
import { userStorageRoot } from '../../server/trailStorage.js'
import {
  DEFAULT_PLAN_ID,
  R2_FREE_BYTES,
  monthlyR2Cost,
} from '../../server/plans.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Endpoint admin unique qui regroupe TOUTES les lectures de la console
// (anciens `overview`, `users`, `maps`, `sanctions`, `notifications`) en un seul
// appel — moins de fonctions serverless (limite Vercel Hobby) et un seul
// aller-retour pour charger le dashboard. Les données partagées (comptes Auth,
// registre des cartes…) ne sont lues qu'une fois.
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
    const [authList, hikes, profiles, moderation, totalBytes, sanctions, notifications] =
      await Promise.all([
        getAuth(adminApp()).listUsers(1000),
        readHikeIndex(),
        readAllProfiles(),
        readAllModeration(),
        r2StorageUsage(),
        readSanctions(),
        readAdminNotifications(),
      ])

    // --- Vue d'ensemble ---
    const publishedCount = hikes.filter((h) => h.status === 'published').length
    const overview = {
      userCount: authList.users.length,
      hikeCount: hikes.length,
      publishedCount,
      draftCount: hikes.length - publishedCount,
      totalBytes,
      freeBytes: R2_FREE_BYTES,
      billableBytes: Math.max(0, totalBytes - R2_FREE_BYTES),
      monthlyCostEur: monthlyR2Cost(totalBytes, true),
    }

    // --- Agrégats des cartes par propriétaire ---
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

    // --- Utilisateurs (avec stockage réel par préfixe) ---
    const users = await Promise.all(
      authList.users.map(async (record) => {
        const profile = profiles.get(record.uid)
        const aggregate = byOwner.get(record.uid)
        const mod = moderation.get(record.uid)
        const usedBytes = await r2UsageForPrefixes([userStorageRoot(record.uid)])
        return {
          uid: record.uid,
          email: record.email ?? null,
          name: profile?.name ?? record.displayName ?? undefined,
          plan: profile?.plan ?? DEFAULT_PLAN_ID,
          isAdmin: isAdminUid(record.uid),
          createdAt: record.metadata.creationTime ?? null,
          emailVerified: record.emailVerified,
          hikeCount: aggregate?.hikeCount ?? 0,
          publishedCount: aggregate?.publishedCount ?? 0,
          mediaCount: aggregate?.mediaCount ?? 0,
          usedBytes,
          monthlyCostEur: monthlyR2Cost(usedBytes),
          status: mod?.status ?? 'active',
          banCount: mod?.banCount ?? 0,
          appeal: mod?.appeal?.message ?? null,
          adminReply: mod?.adminReply?.message ?? null,
        }
      }),
    )
    users.sort(
      (a, b) =>
        Number(b.isAdmin) - Number(a.isAdmin) || b.usedBytes - a.usedBytes,
    )

    // --- God-view des cartes ---
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

    return Response.json(
      { overview, users, maps, sanctions, notifications },
      { headers: jsonHeaders },
    )
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_DASHBOARD_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture admin impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
