import { r2UsageForPrefixes, type StorageScope } from './r2.js'
import { INTERNAL_STORAGE_LIMIT_BYTES, planStorageLimit } from './plans.js'
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

// Vrai des comptes « maison » (admin, créateurs déclarés, internes) qui
// disposent du stockage gratuit du bucket (10 Go) au lieu d'un forfait.
const isHouseAccount = (uid: string, email?: string | null): boolean =>
  isAdminUid(uid) || isCreatorUid(uid) || isInternalEmail(email)

// Limite de stockage d'un compte :
//  - comptes maison → 10 Go (palier gratuit R2 attribué à Quentin) ;
//  - tout autre compte → la limite de SON forfait (Standard 5 Go, Explorateur
//    50 Go, Cartographe 200 Go). Un compte ne peut donc pas dépasser son
//    forfait : pour plus de stockage, il faut passer à un forfait supérieur.
// `planId` vient du profil Firestore (`readProfilePlan`) ; absent => Standard.
export const userStorageLimit = (
  uid: string,
  email?: string | null,
  planId?: string,
): number =>
  isHouseAccount(uid, email)
    ? INTERNAL_STORAGE_LIMIT_BYTES
    : planStorageLimit(planId)

// Portée de quota appliquée à l'utilisateur ENTIER (limite = celle de son
// compte / forfait, cf. `userStorageLimit`).
export const userStorageScope = (
  uid: string,
  email?: string | null,
  planId?: string,
): StorageScope => ({
  limitBytes: userStorageLimit(uid, email, planId),
  usagePrefixes: userStoragePrefixes(uid),
})

// Octets déjà consommés par l'utilisateur (tout son préfixe).
export const userStorageUsage = async (uid: string): Promise<number> => {
  return r2UsageForPrefixes(userStoragePrefixes(uid))
}
