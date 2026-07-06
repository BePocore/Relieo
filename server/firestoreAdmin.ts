import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { adminApp } from './firebaseAdmin.js'

// Profil utilisateur tel que stocké dans Firestore (collection `profiles/<uid>`).
// Côté admin on lit TOUS les profils via l'Admin SDK, ce qui contourne les
// règles de sécurité Firestore (réservées au propriétaire).
export type StoredProfile = {
  uid: string
  name?: string
  location?: string
  bio?: string
  plan?: string
  // Rôle du compte (réservé : le flag est posé par le futur bouton « devenir
  // créateur »). En tranche 1, le rôle effectif vient de l'env `CREATOR_UIDS`.
  accountType?: string
  // Seuil d'alerte stockage (en Go) réglé par l'admin pour ce compte : au-delà,
  // une notif admin est déposée (surveillance des gros consommateurs). 0/absent
  // = pas d'alerte.
  storageAlertGb?: number
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined

// Tous les profils, indexés par uid. Une seule lecture de collection.
export const readAllProfiles = async (): Promise<Map<string, StoredProfile>> => {
  const db = getFirestore(adminApp())
  const snapshot = await db.collection('profiles').get()
  const profiles = new Map<string, StoredProfile>()
  for (const document of snapshot.docs) {
    const data = document.data()
    profiles.set(document.id, {
      uid: document.id,
      name: asString(data.name),
      location: asString(data.location),
      bio: asString(data.bio),
      plan: asString(data.plan),
      accountType: asString(data.accountType),
      storageAlertGb: asNumber(data.storageAlertGb),
    })
  }
  return profiles
}

// Règle le seuil d'alerte stockage (Go) d'un compte (override admin). 0 efface
// l'alerte.
export const setUserStorageAlert = async (
  uid: string,
  storageAlertGb: number,
): Promise<void> => {
  const db = getFirestore(adminApp())
  await db
    .collection('profiles')
    .doc(uid)
    .set(
      { storageAlertGb, updatedAt: new Date().toISOString() },
      { merge: true },
    )
}

// Écrit le forfait d'un utilisateur (override admin), sans toucher au reste.
export const setUserPlan = async (
  uid: string,
  plan: string,
): Promise<void> => {
  const db = getFirestore(adminApp())
  await db
    .collection('profiles')
    .doc(uid)
    .set({ plan, updatedAt: new Date().toISOString() }, { merge: true })
}

// Passage viewer -> créateur : pose le rôle ET le forfait via l'Admin SDK
// (contourne les règles Firestore). Le client ne peut PAS écrire `accountType`
// lui-même (règle Firestore), donc la promotion passe obligatoirement par ici.
export const setAccountCreator = async (
  uid: string,
  plan: string,
): Promise<void> => {
  const db = getFirestore(adminApp())
  await db
    .collection('profiles')
    .doc(uid)
    .set(
      { accountType: 'creator', plan, updatedAt: new Date().toISOString() },
      { merge: true },
    )
}

// Lit le rôle stocké dans le profil (`accountType`), pour que `/api/admin/me`
// renvoie le bon rôle après un passage viewer -> créateur. Une seule lecture de
// document. Renvoie undefined si absent (compte viewer par défaut).
export const readProfileAccountType = async (
  uid: string,
): Promise<string | undefined> => {
  const db = getFirestore(adminApp())
  const snapshot = await db.collection('profiles').doc(uid).get()
  return asString(snapshot.data()?.accountType)
}

// Lit le forfait stocké dans le profil (`plan`), pour appliquer la limite de
// stockage correspondante à l'utilisateur (cf. userStorageLimit). Une seule
// lecture de document ; undefined => forfait par défaut (Standard).
export const readProfilePlan = async (
  uid: string,
): Promise<string | undefined> => {
  const db = getFirestore(adminApp())
  const snapshot = await db.collection('profiles').doc(uid).get()
  return asString(snapshot.data()?.plan)
}

// Notification admin déposée dans le profil de l'utilisateur (champ tableau
// `notifications`), affichée à sa prochaine connexion. arrayUnion ajoute sans
// écraser les autres champs ni les notifications déjà présentes.
export type UserNotification = {
  id: string
  type:
    | 'unpublish'
    | 'delete'
    | 'block'
    | 'delete-account'
    | 'media-rejected'
    | 'info'
  message: string
  mapTitle?: string
  createdAt: string
}

export const pushUserNotification = async (
  uid: string,
  notification: UserNotification,
): Promise<void> => {
  const db = getFirestore(adminApp())
  await db
    .collection('profiles')
    .doc(uid)
    .set(
      {
        notifications: FieldValue.arrayUnion(notification),
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    )
}
