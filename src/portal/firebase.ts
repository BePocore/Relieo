import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth'

// Config web Firebase (valeurs publiques côté client).
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
}

// Firebase n'est actif que si la config est fournie. Sinon le portail retombe
// sur l'authentification localStorage de prototype (pratique avant la config).
export const firebaseEnabled = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId,
)

let app: FirebaseApp | undefined
let authInstance: Auth | undefined

export const getFirebaseAuth = (): Auth | null => {
  if (!firebaseEnabled) return null
  if (!authInstance) {
    app = initializeApp({
      apiKey: config.apiKey!,
      authDomain: config.authDomain!,
      projectId: config.projectId!,
      appId: config.appId!,
    })
    authInstance = getAuth(app)
  }
  return authInstance
}

export const googleProvider = new GoogleAuthProvider()

// Jeton d'identité de l'utilisateur connecté (pour authentifier les appels API
// depuis le Studio, même origine). null si Firebase off ou personne connecté.
export const getIdToken = async (): Promise<string | null> => {
  const auth = getFirebaseAuth()
  if (!auth) return null
  const current =
    auth.currentUser ??
    (await new Promise<User | null>((resolve) => {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        unsubscribe()
        resolve(user)
      })
    }))
  return current ? current.getIdToken() : null
}
