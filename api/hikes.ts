import { hasR2Config, r2GetText } from '../server/r2.js'
import { readHikeIndex, upsertHikeIndex } from '../server/hikeIndex.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { trailLocation } from '../server/trailStorage.js'
import { pickCoverFromProjectJson } from '../server/cover.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

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
    const hikes = await readHikeIndex()
    const filtered = hikes.filter((hike) => hike.ownerId === user.uid)

    // Backfill des cartes publiées sans cover : on pioche une image au hasard
    // dans leur project.json et on la persiste une fois (les sauvegardes
    // suivantes la fournissent déjà). Limité aux cartes publiées et borné pour
    // ne pas multiplier les lectures lourdes sur un dashboard chargé.
    const missing = filtered
      .filter((hike) => !hike.coverUrl && hike.status === 'published')
      .slice(0, 12)
    for (const hike of missing) {
      const body = await r2GetText(
        trailLocation(hike.ownerId, hike.code).projectKey,
      )
      const coverUrl = pickCoverFromProjectJson(body)
      if (coverUrl) {
        hike.coverUrl = coverUrl
        await upsertHikeIndex({ folder: hike.folder, coverUrl })
      }
    }

    return Response.json({ hikes: filtered }, { headers: jsonHeaders })
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
