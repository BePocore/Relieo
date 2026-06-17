import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  browserPopupRedirectResolver,
  browserSessionPersistence,
  GoogleAuthProvider,
  initializeAuth,
  onAuthStateChanged,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  doc,
  getDoc,
  getFirestore,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore'
import type { AccountStatus, PortalNotification, ProfileExtras } from './portalStore'

const cleanEnv = (value: string | undefined): string | undefined => {
  const cleaned = value?.replace(/^\uFEFF/, '').trim()
  return cleaned || undefined
}

// Config web Firebase (valeurs publiques côté client). Le nettoyage du BOM
// protège notamment les valeurs collées ou importées dans Vercel.
const config = {
  apiKey: cleanEnv(import.meta.env.VITE_FIREBASE_API_KEY),
  authDomain: cleanEnv(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN),
  projectId: cleanEnv(import.meta.env.VITE_FIREBASE_PROJECT_ID),
  appId: cleanEnv(import.meta.env.VITE_FIREBASE_APP_ID),
}

// Firebase est obligatoire pour le portail et le Studio authentifie.
export const firebaseEnabled = Boolean(
  config.apiKey && config.authDomain && config.projectId && config.appId,
)

let app: FirebaseApp | undefined
let authInstance: Auth | undefined
let dbInstance: Firestore | undefined

export const getFirebaseAuth = (): Auth | null => {
  if (!firebaseEnabled) return null
  if (!authInstance) {
    app = initializeApp({
      apiKey: config.apiKey!,
      authDomain: config.authDomain!,
      projectId: config.projectId!,
      appId: config.appId!,
    })
    authInstance = initializeAuth(app, {
      persistence: browserSessionPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    })
  }
  return authInstance
}

// Firestore : stockage des profils utilisateurs (nom/localisation/bio) par uid.
// Initialise l'app au passage si besoin.
export const getFirebaseDb = (): Firestore | null => {
  if (!firebaseEnabled) return null
  getFirebaseAuth()
  if (!app) return null
  if (!dbInstance) dbInstance = getFirestore(app)
  return dbInstance
}

const profileDocument = (uid: string) => {
  const db = getFirebaseDb()
  return db ? doc(db, 'profiles', uid) : null
}

export const readUserProfile = async (
  uid: string,
): Promise<ProfileExtras> => {
  const reference = profileDocument(uid)
  if (!reference) throw new Error('Firestore n\u2019est pas configure.')
  const snapshot = await getDoc(reference)
  if (!snapshot.exists()) return {}
  const data = snapshot.data()
  return {
    name: typeof data.name === 'string' ? data.name : undefined,
    location: typeof data.location === 'string' ? data.location : undefined,
    bio: typeof data.bio === 'string' ? data.bio : undefined,
    plan: typeof data.plan === 'string' && data.plan ? data.plan : undefined,
    photoURL:
      typeof data.photoURL === 'string' && data.photoURL
        ? data.photoURL
        : undefined,
  }
}

export const saveUserProfile = async (
  uid: string,
  profile: ProfileExtras,
): Promise<void> => {
  const reference = profileDocument(uid)
  if (!reference) throw new Error('Firestore n\u2019est pas configure.')
  await setDoc(
    reference,
    {
      name: profile.name?.trim() ?? '',
      location: profile.location?.trim() ?? '',
      bio: profile.bio?.trim() ?? '',
      photoURL: profile.photoURL ?? '',
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
}

// Enregistre uniquement la photo de profil (vignette data URL), sans toucher
// au reste du profil. Chaîne vide = retour aux initiales.
export const saveUserPhoto = async (
  uid: string,
  photoURL: string,
): Promise<void> => {
  const reference = profileDocument(uid)
  if (!reference) throw new Error('Firestore n’est pas configure.')
  await setDoc(
    reference,
    { photoURL, updatedAt: serverTimestamp() },
    { merge: true },
  )
}

// Enregistre uniquement le forfait choisi (sans toucher au reste du profil).
export const saveUserPlan = async (
  uid: string,
  plan: string,
): Promise<void> => {
  const reference = profileDocument(uid)
  if (!reference) throw new Error('Firestore n’est pas configure.')
  await setDoc(
    reference,
    { plan, updatedAt: serverTimestamp() },
    { merge: true },
  )
}

// Notifications déposées par l'admin dans le profil (ex : carte dépubliée).
// L'utilisateur lit son propre document (autorisé par les règles Firestore).
export const readUserNotifications = async (
  uid: string,
): Promise<PortalNotification[]> => {
  const reference = profileDocument(uid)
  if (!reference) return []
  const snapshot = await getDoc(reference)
  if (!snapshot.exists()) return []
  const raw = snapshot.data().notifications
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (item): item is PortalNotification =>
        Boolean(item) && typeof item.message === 'string' && typeof item.id === 'string',
    )
    .map((item) => ({ ...item, read: Boolean(item.read) }))
    .sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
}

// Marque des notifications (par id) comme lues, sans les supprimer (elles
// restent consultables dans l'onglet Notifications).
export const markUserNotificationsRead = async (
  uid: string,
  ids: string[],
): Promise<void> => {
  const reference = profileDocument(uid)
  if (!reference) return
  const idSet = new Set(ids)
  const next = (await readUserNotifications(uid)).map((item) =>
    idSet.has(item.id) ? { ...item, read: true } : item,
  )
  await setDoc(
    reference,
    { notifications: next, updatedAt: serverTimestamp() },
    { merge: true },
  )
}

// État de modération du compte (lecture du propre document, autorisée par les
// règles). Renvoie 'active' par défaut si le document n'existe pas.
export const readAccountStatus = async (
  uid: string,
): Promise<AccountStatus> => {
  const db = getFirebaseDb()
  const fallback: AccountStatus = {
    status: 'active',
    message: '',
    appealSent: false,
    adminReply: null,
  }
  if (!db) return fallback
  const snapshot = await getDoc(doc(db, 'moderation', uid))
  if (!snapshot.exists()) return fallback
  const data = snapshot.data()
  return {
    status:
      data.status === 'blocked' || data.status === 'deleted'
        ? data.status
        : 'active',
    message: typeof data.message === 'string' ? data.message : '',
    appealSent: Boolean(data.appeal),
    adminReply:
      data.adminReply && typeof data.adminReply.message === 'string'
        ? data.adminReply.message
        : null,
  }
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
  if (!current) return null
  // Juste après la vérification d'email, le jeton en cache porte encore
  // `email_verified: false` (les claims ne changent qu'au rafraîchissement du
  // jeton, valable ~1h). Si l'utilisateur est vérifié mais que le claim est
  // périmé, on force un rafraîchissement, sinon le serveur rejette les appels
  // (« Connexion requise »).
  if (current.emailVerified) {
    const result = await current.getIdTokenResult()
    if (result.claims.email_verified !== true) {
      return current.getIdToken(true)
    }
    return result.token
  }
  return current.getIdToken()
}

// Appel authentifié vers une route API du compte (mêmes origine et jeton).
const accountFetch = async (
  path: string,
  body: unknown,
): Promise<Response> => {
  const token = await getIdToken()
  if (!token) throw new Error('Connexion requise.')
  return fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

// Message d'appel d'un utilisateur banni (1 seul par bannissement).
export const sendAccountAppeal = async (message: string): Promise<void> => {
  const response = await accountFetch('/api/account', { action: 'appeal', message })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as
      | { message?: string }
      | null
    throw new Error(data?.message ?? 'Envoi impossible.')
  }
}

// Acquittement de suppression : désactive le compte (reconnexion impossible).
export const finalizeAccountDeletion = async (): Promise<void> => {
  await accountFetch('/api/account', { action: 'finalize-deletion' }).catch(
    () => undefined,
  )
}
