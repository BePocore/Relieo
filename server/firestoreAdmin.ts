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
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

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
    })
  }
  return profiles
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
