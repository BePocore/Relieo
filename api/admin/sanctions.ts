import { hasFirebaseAdmin } from '../../server/firebaseAdmin.js'
import { requireAdmin } from '../../server/admin.js'
import { hasR2Config } from '../../server/r2.js'
import { readSanctions } from '../../server/sanctions.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Journal de modération admin : toutes les dépublications / suppressions.
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
    const sanctions = await readSanctions()
    return Response.json({ sanctions }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ADMIN_SANCTIONS_FAILED',
        message:
          error instanceof Error ? error.message : 'Lecture du journal impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
