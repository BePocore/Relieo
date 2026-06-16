import { verifyRequestUser, type AuthedUser } from './firebaseAdmin.js'

// Liste blanche d'uid Firebase autorisés en admin (CSV dans `ADMIN_UIDS`).
// L'uid est immuable, contrairement à l'email : c'est le critère de confiance.
const adminUids = (): string[] =>
  (process.env.ADMIN_UIDS ?? '')
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean)

export const isAdminUser = (user: AuthedUser | null): boolean =>
  Boolean(user && adminUids().includes(user.uid))

// Variante par uid seul (pour marquer les comptes admin dans la liste).
export const isAdminUid = (uid: string): boolean => adminUids().includes(uid)

// Vérifie le jeton ET l'appartenance à l'allowlist admin. Renvoie l'utilisateur
// admin prouvé, ou null (l'appelant traduit en 401/403). À utiliser comme garde
// en tête de CHAQUE endpoint d'administration.
export const requireAdmin = async (
  request: Request,
): Promise<AuthedUser | null> => {
  const user = await verifyRequestUser(request)
  return isAdminUser(user) ? user : null
}
