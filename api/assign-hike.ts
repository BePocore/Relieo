import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import { hasR2Config } from '../server/r2.js'
import { trailLocation } from '../server/trailStorage.js'
import { upsertHikeIndex } from '../server/hikeIndex.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

type AssignBody = {
  code?: string
  ownerId?: string
  title?: string
  status?: 'published' | 'draft'
  distanceKm?: number
  elevationGain?: number
  pointCount?: number
  mediaCount?: number
  coverUrl?: string
}

// Affecte une randonnée DÉJÀ stockée (ex. Halsa) à un utilisateur : écrit
// seulement l'entrée d'index (ownerId + méta), SANS toucher au project.json ni
// aux médias. Opération d'administration → protégée par le mot de passe admin.
export async function POST(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  if (!hasAdminPassword() || !isAdminRequest(request)) {
    return Response.json(
      { message: 'Mot de passe admin requis.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const body = (await request.json()) as AssignBody
    const code = body.code?.trim()
    const ownerId = body.ownerId?.trim()
    if (!code || !ownerId) {
      return Response.json(
        { message: 'code et ownerId sont obligatoires.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const target = trailLocation(code)
    const index = await upsertHikeIndex({
      code: target.code,
      folder: target.folder,
      ownerId,
      title: body.title?.trim() || target.code,
      status: body.status === 'draft' ? 'draft' : 'published',
      distanceKm:
        typeof body.distanceKm === 'number' ? body.distanceKm : undefined,
      elevationGain:
        typeof body.elevationGain === 'number' ? body.elevationGain : undefined,
      pointCount:
        typeof body.pointCount === 'number' ? body.pointCount : undefined,
      mediaCount:
        typeof body.mediaCount === 'number' ? body.mediaCount : undefined,
      coverUrl: body.coverUrl?.trim() || undefined,
      updatedAt: new Date().toISOString(),
    })

    const assigned = index.find((hike) => hike.folder === target.folder)
    return Response.json({ assigned }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'ASSIGN_FAILED',
        message: error instanceof Error ? error.message : 'Affectation impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
