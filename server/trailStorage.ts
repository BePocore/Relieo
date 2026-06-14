export const activeTrailPath = 'rando3d/active.json'
export const legacyProjectPath = 'rando3d/project.json'

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

export const trailLocation = (code: string): ActiveTrail => {
  const folder = trailFolder(code)
  const prefix = `rando3d/randonnees/${folder}`
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
