import { next } from '@vercel/edge'

// Vercel Edge Middleware : pour un robot d'aperçu (Discord, WhatsApp, iMessage,
// Facebook, X…) qui ouvre un lien de carte, on injecte les balises Open Graph
// (image, titre, description) dans le HTML, en lisant le JSON public
// `relieo/public/og/<slug>.json` (aucun secret côté Edge). Les vrais visiteurs
// passent tout droit (`next()`), la SPA est inchangée. Ne compte PAS dans la
// limite des 12 fonctions serverless Vercel.
export const config = { matcher: '/' }

const CRAWLER =
  /(facebookexternalhit|facebot|twitterbot|discordbot|slackbot|slack-imgproxy|whatsapp|telegrambot|linkedinbot|pinterest|redditbot|googlebot|bingbot|embedly|quora link preview|showyoubot|outbrain|vkshare|skypeuripreview|applebot|iframely|mastodon|bsky|snapchat)/i

const MEDIA_BASE = 'https://media.relieo.fr'

const esc = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export default async function middleware(request: Request): Promise<Response> {
  const userAgent = request.headers.get('user-agent') ?? ''
  if (!CRAWLER.test(userAgent)) return next()

  const url = new URL(request.url)
  const slug = url.searchParams.get('m') ?? url.searchParams.get('code')
  if (!slug) return next()

  try {
    const metaResponse = await fetch(
      `${MEDIA_BASE}/relieo/public/og/${encodeURIComponent(slug)}.json`,
    )
    if (!metaResponse.ok) return next()
    const meta = (await metaResponse.json()) as {
      title?: string
      description?: string
      image?: string
    }

    const pageResponse = await fetch(new URL('/index.html', url.origin))
    if (!pageResponse.ok) return next()
    let html = await pageResponse.text()

    const title = esc(meta.title?.trim() || 'Relieo')
    const description = esc(meta.description?.trim() || '')
    const image = esc(meta.image?.trim() || '')
    const pageUrl = esc(url.href)

    const tags =
      `<meta property="og:type" content="website" />` +
      `<meta property="og:site_name" content="Relieo" />` +
      `<meta property="og:title" content="${title}" />` +
      `<meta property="og:description" content="${description}" />` +
      (image ? `<meta property="og:image" content="${image}" />` : '') +
      `<meta property="og:url" content="${pageUrl}" />` +
      `<meta name="twitter:card" content="summary_large_image" />` +
      `<meta name="twitter:title" content="${title}" />` +
      `<meta name="twitter:description" content="${description}" />` +
      (image ? `<meta name="twitter:image" content="${image}" />` : '')

    html = html
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`)
      .replace('</head>', `${tags}</head>`)

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    })
  } catch {
    return next()
  }
}
