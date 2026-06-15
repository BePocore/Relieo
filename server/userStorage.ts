import { foldersForOwner } from './hikeIndex.js'
import { r2UsageForPrefixes, type StorageScope } from './r2.js'
import { FREE_STORAGE_LIMIT_BYTES } from './plans.js'

// Préfixe R2 d'un dossier de randonnée (avec slash final pour éviter qu'un
// dossier `foo` ne capture `foo-2`).
const folderPrefix = (folder: string): string =>
  `rando3d/randonnees/${folder}/`

// Tous les préfixes de stockage d'un utilisateur : ses dossiers déjà connus
// (index) + un éventuel dossier en cours (rando neuve pas encore indexée).
export const userStoragePrefixes = async (
  uid: string,
  extraFolder?: string,
): Promise<string[]> => {
  const folders = await foldersForOwner(uid)
  if (extraFolder) folders.push(extraFolder)
  return Array.from(new Set(folders.filter(Boolean))).map(folderPrefix)
}

// Portée de quota du forfait gratuit (5 Go) appliquée à l'utilisateur ENTIER.
export const userStorageScope = async (
  uid: string,
  extraFolder?: string,
): Promise<StorageScope> => ({
  limitBytes: FREE_STORAGE_LIMIT_BYTES,
  usagePrefixes: await userStoragePrefixes(uid, extraFolder),
})

// Octets déjà consommés par l'utilisateur (somme de tous ses dossiers).
export const userStorageUsage = async (uid: string): Promise<number> => {
  return r2UsageForPrefixes(await userStoragePrefixes(uid))
}
