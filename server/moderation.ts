import { getFirestore } from 'firebase-admin/firestore'
import { adminApp } from './firebaseAdmin.js'

// État de modération d'un compte, stocké dans Firestore `moderation/<uid>`.
// Écrit UNIQUEMENT par l'Admin SDK (les règles interdisent l'écriture client) :
// un utilisateur sanctionné ne peut donc pas lever son propre ban en écrivant
// son profil. Il peut seulement LIRE son propre document.
export type ModerationStatus = 'active' | 'blocked' | 'deleted'

export type ModerationAppeal = {
  message: string
  sentAt: string
}

export type ModerationRecord = {
  status: ModerationStatus
  message: string
  // Nombre total de bannissements reçus (jamais décrémenté) : sert de seuil aux
  // 3 bannissements requis avant de pouvoir supprimer le compte.
  banCount: number
  updatedAt: string | null
  // Message d'appel envoyé par l'utilisateur pour le ban en cours (1 seul).
  appeal: ModerationAppeal | null
}

const DEFAULT: ModerationRecord = {
  status: 'active',
  message: '',
  banCount: 0,
  updatedAt: null,
  appeal: null,
}

const docRef = (uid: string) =>
  getFirestore(adminApp()).collection('moderation').doc(uid)

export const readModeration = async (
  uid: string,
): Promise<ModerationRecord> => {
  const snapshot = await docRef(uid).get()
  if (!snapshot.exists) return { ...DEFAULT }
  const data = snapshot.data() ?? {}
  return {
    status:
      data.status === 'blocked' || data.status === 'deleted'
        ? data.status
        : 'active',
    message: typeof data.message === 'string' ? data.message : '',
    banCount: typeof data.banCount === 'number' ? data.banCount : 0,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    appeal:
      data.appeal && typeof data.appeal.message === 'string'
        ? { message: data.appeal.message, sentAt: data.appeal.sentAt ?? '' }
        : null,
  }
}

// Lecture en lot (vue admin des utilisateurs). Une seule lecture de collection.
export const readAllModeration = async (): Promise<
  Map<string, ModerationRecord>
> => {
  const snapshot = await getFirestore(adminApp()).collection('moderation').get()
  const records = new Map<string, ModerationRecord>()
  for (const document of snapshot.docs) {
    const data = document.data()
    records.set(document.id, {
      status:
        data.status === 'blocked' || data.status === 'deleted'
          ? data.status
          : 'active',
      message: typeof data.message === 'string' ? data.message : '',
      banCount: typeof data.banCount === 'number' ? data.banCount : 0,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      appeal:
        data.appeal && typeof data.appeal.message === 'string'
          ? { message: data.appeal.message, sentAt: data.appeal.sentAt ?? '' }
          : null,
    })
  }
  return records
}

export const setModeration = async (
  uid: string,
  patch: Partial<ModerationRecord>,
): Promise<void> => {
  await docRef(uid).set(
    { ...patch, updatedAt: new Date().toISOString() },
    { merge: true },
  )
}

// Enregistre l'appel de l'utilisateur banni (1 seul par ban). Renvoie false si
// un appel a déjà été déposé pour le ban en cours.
export const appendAppeal = async (
  uid: string,
  message: string,
): Promise<boolean> => {
  const current = await readModeration(uid)
  if (current.appeal) return false
  await docRef(uid).set(
    {
      appeal: { message, sentAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  )
  return true
}
