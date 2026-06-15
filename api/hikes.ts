import { hasR2Config } from '../server/r2.js'
import { readHikeIndex } from '../server/hikeIndex.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'

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
