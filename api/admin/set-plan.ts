import { hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import { setUserPlan } from '../../server/firestoreAdmin.js'
import { PLAN_STORAGE_LIMITS } from '../../server/plans.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type SetPlanBody = { uid?: string; plan?: string }

// Override admin du forfait d'un utilisateur (écrit profiles/<uid>.plan).
export async function POST(request: Request) {
  if (!hasFirebaseAdmin()) {
    return Response.json(
      { message: 'Firebase Admin est requis.' },
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
    const body = (await request.json()) as SetPlanBody
    const uid = body.uid?.trim()
    const plan = body.plan?.trim()
    if (!uid || !plan) {
      return Response.json(
        { message: 'uid et plan sont obligatoires.' },
        { status: 400, headers: jsonHeaders },
      )
    }
    if (!(plan in PLAN_STORAGE_LIMITS)) {
      return Response.json(
        { message: `Forfait inconnu : ${plan}.` },
        { status: 400, headers: jsonHeaders },
      )
    }
    await setUserPlan(uid, plan)
    return Response.json({ uid, plan }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_SET_PLAN_FAILED',
        message:
          error instanceof Error ? error.message : 'Mise à jour du forfait impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
