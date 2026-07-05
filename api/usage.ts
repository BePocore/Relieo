import { hasR2Config } from '../server/r2.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { readProfilePlan } from '../server/firestoreAdmin.js'
import { userStorageLimit, userStorageUsage } from '../server/userStorage.js'
import { DEFAULT_PLAN_ID, isUnlimitedStorage } from '../server/plans.js'
import { maybeAlertStorageThreshold } from '../server/storageAlerts.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Usage de stockage de l'utilisateur connecté : octets consommés (toutes ses
// randonnées cumulées) + limite de son forfait. Alimente la jauge du dashboard.
export async function GET(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  if (!hasFirebaseAdmin()) {
    return Response.json(
      { message: 'Firebase Admin n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  const user = await verifyRequestUser(request)
  if (!user) {
    return Response.json(
      { message: 'Connexion requise.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const plan = await readProfilePlan(user.uid)
    const usedBytes = await userStorageUsage(user.uid)
    const limit = userStorageLimit(user.uid, user.email, plan)
    const unlimited = isUnlimitedStorage(limit)

    // Compte illimité : pas de blocage, mais on prévient l'admin quand l'usage
    // franchit un palier (surveillance des gros comptes). Best-effort.
    if (unlimited) {
      await maybeAlertStorageThreshold(user.uid, user.email, usedBytes)
    }

    return Response.json(
      {
        usedBytes,
        // Infinity n'est pas sérialisable en JSON → null + drapeau `unlimited`.
        limitBytes: unlimited ? null : limit,
        unlimited,
        planId: plan ?? DEFAULT_PLAN_ID,
      },
      { headers: jsonHeaders },
    )
  } catch (error) {
    return Response.json(
      {
        code: 'STORAGE_READ_FAILED',
        message: error instanceof Error ? error.message : 'Lecture R2 impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
