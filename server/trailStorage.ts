export const activeTrailPath = 'relieo/active.json'
export const legacyProjectPath = 'relieo/project.json'

// Racine de stockage par utilisateur. Chaque rando vit sous le préfixe de son
// propriétaire : `relieo/users/<uid>/randonnees/<folder>/`. Tout ce qu'un
// utilisateur stocke (publié ou non) tombe ainsi sous `userStorageRoot(uid)`,
// ce qui rend son quota exact et empêche d'écrire dans le dossier d'un autre.
export const STUDIO_OWNER = '_studio'

export const userStorageRoot = (uid: string): string =>
  `relieo/users/${uid || STUDIO_OWNER}/`

export type ActiveTrail = {
  code: string
  folder: string
  prefix: string
  projectKey: string
  updatedAt: string
}

export const trailFolder = (code: string): string => {
  const folder = code
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!folder) throw new Error('Le code de la randonnée est obligatoire.')
  return folder.slice(0, 80)
}

export const trailLocation = (uid: string, code: string): ActiveTrail => {
  const folder = trailFolder(code)
  const prefix = `${userStorageRoot(uid)}randonnees/${folder}`
  return {
    code: code.trim(),
    folder,
    prefix,
    projectKey: `${prefix}/project.json`,
    updatedAt: new Date().toISOString(),
  }
}

export const cleanStorageName = (name: string): string => {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'media'
  )
}
