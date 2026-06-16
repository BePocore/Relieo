import { cert, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const cleanEnv = (value: string | undefined): string | undefined => {
  const cleaned = value?.replace(/^\uFEFF/, '').trim()
  return cleaned || undefined
}

const cleanPrivateKey = (value: string | undefined): string | undefined => {
  let cleaned = cleanEnv(value)
  if (!cleaned) return undefined

  if (cleaned.startsWith('{')) {
    try {
      const serviceAccount = JSON.parse(cleaned) as { private_key?: unknown }
      if (typeof serviceAccount.private_key === 'string') {
        cleaned = serviceAccount.private_key
      }
    } catch {
      // L'extraction du bloc PEM ci-dessous gère aussi un JSON imparfait.
    }
  }

  const quoted =
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  if (quoted) cleaned = cleaned.slice(1, -1)
  cleaned = cleaned
    .replace(/^\uFEFF/, '')
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')

  const begin = '-----BEGIN PRIVATE KEY-----'
  const end = '-----END PRIVATE KEY-----'
  const beginIndex = cleaned.indexOf(begin)
  const endIndex = cleaned.indexOf(end, beginIndex)
  if (beginIndex >= 0 && endIndex >= 0) {
    return cleaned.slice(beginIndex, endIndex + end.length)
  }

  return cleaned.trim()
}

// Décode un base64 (insensible aux retours à la ligne / guillemets). Renvoie le
// texte décodé, ou undefined si vide. Permet de fournir la clé privée OU le JSON
// de compte de service entier en base64, à l'épreuve de l'échappement `\n`.
const decodeBase64 = (value: string | undefined): string | undefined => {
  const cleaned = cleanEnv(value)
  if (!cleaned) return undefined
  try {
    return Buffer.from(cleaned, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

// Identité serveur Firebase via clé de service (variables d'env secrètes).
// `FIREBASE_PRIVATE_KEY_B64` (base64 de la clé PEM ou du JSON complet) est
// prioritaire : c'est la voie robuste, immunisée contre les `\n` mal échappés.
// Repli sur `FIREBASE_PRIVATE_KEY` (PEM brut, avec normalisation des `\n`).
const config = () => ({
  projectId: cleanEnv(process.env.FIREBASE_PROJECT_ID),
  clientEmail: cleanEnv(process.env.FIREBASE_CLIENT_EMAIL),
  privateKey: cleanPrivateKey(
    decodeBase64(process.env.FIREBASE_PRIVATE_KEY_B64) ??
      process.env.FIREBASE_PRIVATE_KEY,
  ),
})

export const hasFirebaseAdmin = (): boolean => {
  const current = config()
  return Boolean(current.projectId && current.clientEmail && current.privateKey)
}

// Diagnostic NON sensible de la configuration (n'expose jamais la clé). Sert à
// comprendre un échec de credential (DECODER, etc.) sans révéler de secret.
export const firebaseAdminDiagnostics = () => {
  const current = config()
  const key = current.privateKey
  return {
    keySource: process.env.FIREBASE_PRIVATE_KEY_B64
      ? 'b64'
      : process.env.FIREBASE_PRIVATE_KEY
        ? 'raw'
        : 'none',
    projectIdSet: Boolean(current.projectId),
    clientEmailSet: Boolean(current.clientEmail),
    keyPresent: Boolean(key),
    keyLength: key?.length ?? 0,
    keyHasBegin: key ? key.includes('-----BEGIN PRIVATE KEY-----') : false,
    keyHasEnd: key ? key.includes('-----END PRIVATE KEY-----') : false,
    keyHasRealNewlines: key ? key.includes('\n') : false,
    keyHasLiteralBackslashN: key ? key.includes('\\n') : false,
  }
}

let app: App | undefined
// App Firebase Admin partagée (Auth + Firestore admin). Exportée pour permettre
// l'accès Firestore côté serveur (server/firestoreAdmin.ts).
export const adminApp = (): App => {
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
    // Le contrôle d'email vérifié est appliqué côté serveur : un compte
    // mot de passe non vérifié ne doit pas pouvoir agir via un appel direct
    // aux API en contournant l'écran de blocage du portail. Les comptes
    // Google portent toujours `email_verified: true`.
    if (decoded.email_verified !== true) return null
    return { uid: decoded.uid, email: decoded.email ?? null }
  } catch (error) {
    console.error(
      'Firebase ID token verification failed:',
      error instanceof Error ? error.message : 'Unknown Firebase Admin error',
    )
    return null
  }
}
