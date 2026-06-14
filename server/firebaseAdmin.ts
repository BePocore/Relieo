import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

// Identité serveur Firebase via clé de service (variables d'env secrètes).
const config = () => ({
  projectId: process.env.FIREBASE_PROJECT_ID?.trim(),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL?.trim(),
  // La clé privée peut contenir des \n littéraux quand elle vient d'un .env.
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
})

export const hasFirebaseAdmin = (): boolean => {
  const current = config()
  return Boolean(current.projectId && current.clientEmail && current.privateKey)
}

let app: App | undefined
const adminApp = (): App => {
  if (app) return app
  const current = config()
  app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: current.projectId!,
        clientEmail: current.clientEmail!,
        privateKey: current.privateKey!,
      }),
    })
  return app
}

export type AuthedUser = { uid: string; email: string | null }

// Vérifie l'en-tête `Authorization: Bearer <idToken>`. Renvoie l'utilisateur
// prouvé, ou null si absent/invalide/non configuré.
export const verifyRequestUser = async (
  request: Request,
): Promise<AuthedUser | null> => {
  if (!hasFirebaseAdmin()) return null
  const header = request.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  try {
    const decoded = await getAuth(adminApp()).verifyIdToken(match[1].trim())
    return { uid: decoded.uid, email: decoded.email ?? null }
  } catch {
    return null
  }
}
