import { r2UsageForPrefixes, type StorageScope } from './r2.js'
import { FREE_STORAGE_LIMIT_BYTES } from './plans.js'
import { userStorageRoot } from './trailStorage.js'

// Tous les octets d'un utilisateur vivent sous un préfixe unique
// `relieo/users/<uid>/`. Le quota est donc la somme de ce seul préfixe : il
// couvre TOUT (publié ou non), sans dépendre de l'indexation des dossiers.
export const userStoragePrefixes = (uid: string): string[] => [
  userStorageRoot(uid),
]

// Portée de quota du forfait gratuit (5 Go) appliquée à l'utilisateur ENTIER.
export const userStorageScope = (uid: string): StorageScope => ({
  limitBytes: FREE_STORAGE_LIMIT_BYTES,
  usagePrefixes: userStoragePrefixes(uid),
})

// Octets déjà consommés par l'utilisateur (tout son préfixe).
export const userStorageUsage = async (uid: string): Promise<number> => {
  return r2UsageForPrefixes(userStoragePrefixes(uid))
}
