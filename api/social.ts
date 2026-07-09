import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import {
  getContext,
  getCreator,
  getExplore,
  getFeed,
  getSavedCards,
  getSuggestions,
  isHandleAvailable,
  searchAll,
  setFollow,
  setHandle,
  setLike,
  setSave,
} from '../server/social.js'

// Route unique du réseau social (feed / explorer / profils / suivis / pseudos).
// Consolidée en UNE fonction serverless pour rester sous la limite Vercel Hobby
// (12 fonctions) : on aiguille par `?action=` (GET) ou `body.action` (POST).
const jsonHeaders = { 'Cache-Control': 'no-store' }

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: jsonHeaders })

// Lectures : feed, explore, creator, context, suggestions.
export async function GET(request: Request) {
  if (!hasFirebaseAdmin()) return json({ error: 'unconfigured' }, 503)
  const user = await verifyRequestUser(request)
  if (!user) return json({ error: 'unauthenticated' }, 401)

  const url = new URL(request.url)
  const action = url.searchParams.get('action') ?? 'feed'
  try {
    switch (action) {
      case 'feed':
        return json({ cards: await getFeed(user.uid) })
      case 'explore':
        return json({ cards: await getExplore() })
      case 'saved':
        return json({ cards: await getSavedCards(user.uid) })
      case 'suggestions':
        return json({ creators: await getSuggestions(user.uid) })
      case 'search':
        return json(await searchAll(user.uid, url.searchParams.get('q') ?? ''))
      case 'context':
        return json(await getContext(user.uid, user.email ?? ''))
      case 'creator': {
        const uid = url.searchParams.get('uid')?.trim() ?? ''
        const result = await getCreator(user.uid, uid)
        return result ? json(result) : json({ error: 'not-found' }, 404)
      }
      default:
        return json({ error: 'unknown-action' }, 400)
    }
  } catch (error) {
    console.error('social GET failed:', error instanceof Error ? error.message : error)
    return json({ error: 'server-error' }, 500)
  }
}

// Écritures : follow / unfollow, check-handle, set-handle.
export async function POST(request: Request) {
  if (!hasFirebaseAdmin()) return json({ error: 'unconfigured' }, 503)
  const user = await verifyRequestUser(request)
  if (!user) return json({ error: 'unauthenticated' }, 401)

  let body: { action?: string; uid?: string; handle?: string; slug?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: 'bad-request' }, 400)
  }

  try {
    switch (body.action) {
      case 'follow':
        return json(await setFollow(user.uid, body.uid ?? '', true))
      case 'unfollow':
        return json(await setFollow(user.uid, body.uid ?? '', false))
      case 'like':
        return json(await setLike(user.uid, body.slug ?? '', true))
      case 'unlike':
        return json(await setLike(user.uid, body.slug ?? '', false))
      case 'save':
        return json(await setSave(user.uid, body.slug ?? '', true))
      case 'unsave':
        return json(await setSave(user.uid, body.slug ?? '', false))
      case 'check-handle':
        return json(await isHandleAvailable(user.uid, body.handle ?? ''))
      case 'set-handle':
        return json(await setHandle(user.uid, body.handle ?? ''))
      default:
        return json({ error: 'unknown-action' }, 400)
    }
  } catch (error) {
    console.error('social POST failed:', error instanceof Error ? error.message : error)
    return json({ error: 'server-error' }, 500)
  }
}
