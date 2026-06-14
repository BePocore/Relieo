import { hasR2Config } from '../server/r2.js'
import { readHikeIndex } from '../server/hikeIndex.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Liste les randonnées du registre. `?ownerId=<id>` filtre celles d'un
// propriétaire (ce qu'affiche son dashboard). Métadonnées publiques : pas de
// mot de passe requis pour lire la liste.
export async function GET(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  try {
    const ownerId = new URL(request.url).searchParams.get('ownerId')?.trim()
    const hikes = await readHikeIndex()
    const filtered = ownerId
      ? hikes.filter((hike) => hike.ownerId === ownerId)
      : hikes
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
