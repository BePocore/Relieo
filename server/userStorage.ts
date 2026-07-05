import { r2UsageForPrefixes, type StorageScope } from './r2.js'
import { FREE_STORAGE_LIMIT_BYTES, INTERNAL_STORAGE_LIMIT_BYTES } from './plans.js'
import { userStorageRoot } from './trailStorage.js'
import { isAdminUid } from './admin.js'
import { isCreatorUid } from './roles.js'
import { isInternalEmail } from './costs.js'

// Tous les octets d'un utilisateur vivent sous un préfixe unique
// `relieo/users/<uid>/`. Le quota est donc la somme de ce seul préfixe : il
// couvre TOUT (publié ou non), sans dépendre de l'indexation des dossiers.
export const userStoragePrefixes = (uid: string): string[] => [
  userStorageRoot(uid),
]

// Limite de stockage d'un compte. Les comptes « maison » (admin, créateurs,
// internes) montent à 10 Go ; les autres (viewers, futurs vrais utilisateurs)
// restent au forfait gratuit (5 Go). L'email est optionnel : quand on ne
// dispose que de l'uid (ex. quota du propriétaire d'une carte), admin/créateur
// suffisent déjà à identifier les comptes maison.
export const userStorageLimit = (
  uid: string,
  email?: string | null,
): number =>
  isAdminUid(uid) || isCreatorUid(uid) || isInternalEmail(email)
    ? INTERNAL_STORAGE_LIMIT_BYTES
    : FREE_STORAGE_LIMIT_BYTES

// Portée de quota appliquée à l'utilisateur ENTIER (limite = celle de son
// compte, cf. `userStorageLimit`).
export const userStorageScope = (
  uid: string,
  email?: string | null,
): StorageScope => ({
  limitBytes: userStorageLimit(uid, email),
  usagePrefixes: userStoragePrefixes(uid),
})

// Octets déjà consommés par l'utilisateur (tout son préfixe).
export const userStorageUsage = async (uid: string): Promise<number> => {
  return r2UsageForPrefixes(userStoragePrefixes(uid))
}
