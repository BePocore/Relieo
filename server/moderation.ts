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
  // Id de la notification admin correspondante (pour relier la réponse au ban
  // en cours et l'afficher sur l'écran de blocage de l'utilisateur).
  notifId?: string
}

// Demande de suppression émise par l'utilisateur lui-même (en attente de l'admin).
export type DeletionRequest = {
  message: string
  requestedAt: string
}

export type ModerationRecord = {
  status: ModerationStatus
  message: string
  // Gel des envois (soft) : le compte reste actif (consultation OK) mais ne
  // peut plus uploader ni sauvegarder de contenu. Moins radical qu'un blocage,
  // réversible. Écrit admin-only comme le reste.
  uploadsFrozen: boolean
  // Nombre total de bannissements reçus (jamais décrémenté) : sert de seuil aux
  // 3 bannissements requis avant de pouvoir supprimer le compte.
  banCount: number
  updatedAt: string | null
  // Message d'appel envoyé par l'utilisateur pour le ban en cours (1 seul).
  appeal: ModerationAppeal | null
  // Réponse de l'admin à l'appel, affichée à l'utilisateur sur l'écran de blocage.
  adminReply: ModerationAppeal | null
  // Demande de suppression volontaire en attente de traitement par l'admin.
  deletionRequest: DeletionRequest | null
  // Email/date/admin conservés pour tracer un compte supprimé dont l'auth
  // Firebase n'existe plus (suppression volontaire libère l'email).
  email: string | null
  deletedAt: string | null
  deletedBy: string | null
}

const DEFAULT: ModerationRecord = {
  status: 'active',
  message: '',
  uploadsFrozen: false,
  banCount: 0,
  updatedAt: null,
  appeal: null,
  adminReply: null,
  deletionRequest: null,
  email: null,
  deletedAt: null,
  deletedBy: null,
}

const parseAppeal = (value: unknown): ModerationAppeal | null =>
  value && typeof (value as ModerationAppeal).message === 'string'
    ? {
        message: (value as ModerationAppeal).message,
        sentAt: (value as ModerationAppeal).sentAt ?? '',
        notifId: (value as ModerationAppeal).notifId,
      }
    : null

const parseDeletionRequest = (value: unknown): DeletionRequest | null =>
  value && typeof (value as DeletionRequest).message === 'string'
    ? {
        message: (value as DeletionRequest).message,
        requestedAt: (value as DeletionRequest).requestedAt ?? '',
      }
    : null

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
    uploadsFrozen: data.uploadsFrozen === true,
    banCount: typeof data.banCount === 'number' ? data.banCount : 0,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
    appeal: parseAppeal(data.appeal),
    adminReply: parseAppeal(data.adminReply),
    deletionRequest: parseDeletionRequest(data.deletionRequest),
    email: typeof data.email === 'string' ? data.email : null,
    deletedAt: typeof data.deletedAt === 'string' ? data.deletedAt : null,
    deletedBy: typeof data.deletedBy === 'string' ? data.deletedBy : null,
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
      uploadsFrozen: data.uploadsFrozen === true,
      banCount: typeof data.banCount === 'number' ? data.banCount : 0,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      appeal: parseAppeal(data.appeal),
      adminReply: parseAppeal(data.adminReply),
      deletionRequest: parseDeletionRequest(data.deletionRequest),
      email: typeof data.email === 'string' ? data.email : null,
      deletedAt: typeof data.deletedAt === 'string' ? data.deletedAt : null,
      deletedBy: typeof data.deletedBy === 'string' ? data.deletedBy : null,
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
// un appel a déjà été déposé pour le ban en cours. `notifId` relie l'appel à sa
// notification admin (pour afficher la réponse du ban en cours à l'utilisateur).
export const appendAppeal = async (
  uid: string,
  message: string,
  notifId: string,
): Promise<boolean> => {
  const current = await readModeration(uid)
  if (current.appeal) return false
  await docRef(uid).set(
    {
      appeal: { message, sentAt: new Date().toISOString(), notifId },
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  )
  return true
}
