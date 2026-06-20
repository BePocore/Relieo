import { createHash, timingSafeEqual } from 'node:crypto'

// Mur d'accès temporaire « site en développement ». Le mot de passe attendu vit
// uniquement côté serveur (variable d'env SITE_GATE_PASSWORD) : il n'est JAMAIS
// envoyé au navigateur. Quand la variable n'est pas définie, le mur est désactivé
// (utile en local / si on veut rouvrir le site). À retirer au lancement public.

const jsonHeaders = { 'Cache-Control': 'no-store' }
const COOKIE_NAME = 'relieo_gate'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 jours

const gatePassword = (): string => (process.env.SITE_GATE_PASSWORD ?? '').trim()

// Le cookie ne contient pas le mot de passe mais son empreinte : on ne peut le
// forger sans connaître le mot de passe.
const tokenFor = (password: string): string =>
  createHash('sha256').update(`relieo-gate:${password}`).digest('hex')

const sameToken = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

const setCookieValue = (token: string): string =>
  `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`

// GET : l'appelant a-t-il déjà franchi le mur ? (ou le mur est-il désactivé ?)
export async function GET(request: Request) {
  const password = gatePassword()
  if (!password) {
    return Response.json({ ok: true, disabled: true }, { headers: jsonHeaders })
  }
  const cookie = readCookie(request, COOKIE_NAME)
  const ok = Boolean(cookie && sameToken(cookie, tokenFor(password)))
  return Response.json({ ok }, { headers: jsonHeaders })
}

// POST { password } : vérifie le mot de passe et, si correct, pose le cookie.
export async function POST(request: Request) {
  const password = gatePassword()
  if (!password) {
    return Response.json({ ok: true, disabled: true }, { headers: jsonHeaders })
  }
  const body = (await request.json().catch(() => ({}))) as { password?: string }
  const candidate = (body.password ?? '').trim()
  if (!sameToken(tokenFor(candidate), tokenFor(password))) {
    // Ralentit légèrement les tentatives en force brute.
    await new Promise((resolve) => setTimeout(resolve, 500))
    return Response.json({ ok: false }, { status: 401, headers: jsonHeaders })
  }
  const headers = new Headers(jsonHeaders)
  headers.append('Set-Cookie', setCookieValue(tokenFor(password)))
  return Response.json({ ok: true }, { headers })
}
