import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  GoogleAuthProvider,
  initializeAuth,
  onAuthStateChanged,
  signOut,
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
// Config extraite dans firebaseConfig.ts (sans SDK) pour que le graphe de la
// carte connaisse firebaseEnabled sans télécharger le SDK (cf. firebaseLazy.ts).
import { firebaseEnabled, firebaseWebConfig as config } from './firebaseConfig'

export { firebaseEnabled }

let app: FirebaseApp | undefined
let authInstance: Auth | undefined
let dbInstance: Firestore | undefined

// Session « rester connecté » : 7 jours glissants. En persistance locale,
// Firebase conserve le refresh token indéfiniment ; on ajoute une expiration
// maison en mémorisant la date de dernière visite et en déconnectant si le
// délai est dépassé. Chaque ouverture du site dans les 7 jours repousse
// l'échéance d'autant.
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const LAST_SEEN_KEY = 'relieoAuthLastSeen'

const readLastSeen = (): number => {
  try {
    return Number(window.localStorage.getItem(LAST_SEEN_KEY)) || 0
  } catch {
    return 0
  }
}

const writeLastSeen = (value: number | null): void => {
  try {
    if (value === null) window.localStorage.removeItem(LAST_SEEN_KEY)
    else window.localStorage.setItem(LAST_SEEN_KEY, String(value))
  } catch {
    // localStorage indisponible (navigation privée stricte) : on ignore.
  }
}

export const getFirebaseAuth = (): Auth | null => {
  if (!firebaseEnabled) return null
  if (!authInstance) {
    app = initializeApp({
      apiKey: config.apiKey!,
      authDomain: config.authDomain!,
      projectId: config.projectId!,
      appId: config.appId!,
    })
    const instance = initializeAuth(app, {
      persistence: browserLocalPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    })
    // Expiration glissante de 7 jours par-dessus la persistance locale : à
    // chaque chargement, on déconnecte si la dernière visite est trop ancienne,
    // sinon on repousse l'échéance.
    onAuthStateChanged(instance, (user) => {
      if (!user) {
        writeLastSeen(null)
        return
      }
      const lastSeen = readLastSeen()
      if (lastSeen && Date.now() - lastSeen > SESSION_MAX_AGE_MS) {
        writeLastSeen(null)
        void signOut(instance)
        return
      }
      writeLastSeen(Date.now())
    })
    authInstance = instance
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
    termsAccepted: data.termsAccepted === true,
    termsAcceptedAt:
      typeof data.termsAcceptedAt === 'string' ? data.termsAcceptedAt : undefined,
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

// Enregistre l'acceptation des CGU (consentement à la modération IA incluse).
// Renvoie l'horodatage ISO posé, pour rafraîchir la session sans relecture.
export const saveTermsAcceptance = async (uid: string): Promise<string> => {
  const reference = profileDocument(uid)
  if (!reference) throw new Error('Firestore n’est pas configure.')
  const acceptedAt = new Date().toISOString()
  await setDoc(
    reference,
    { termsAccepted: true, termsAcceptedAt: acceptedAt, updatedAt: serverTimestamp() },
    { merge: true },
  )
  return acceptedAt
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
    deletionRequested: false,
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
    deletionRequested: Boolean(data.deletionRequest),
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

// Demande volontaire de suppression de compte (transmise à l'admin en notif).
export const requestAccountDeletion = async (message: string): Promise<void> => {
  const response = await accountFetch('/api/account', {
    action: 'request-deletion',
    message,
  })
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

// Passage viewer -> créateur : pose le rôle créateur + le forfait via l'endpoint
// serveur (Admin SDK). Le rôle n'est JAMAIS écrit par le client (la règle
// Firestore l'interdit), pour empêcher l'auto-promotion.
export const saveBecomeCreator = async (plan: string): Promise<void> => {
  const response = await accountFetch('/api/account', {
    action: 'become-creator',
    plan,
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as
      | { message?: string }
      | null
    throw new Error(data?.message ?? 'Passage en créateur impossible.')
  }
}
