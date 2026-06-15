export type PortalUser = {
  id: string
  name: string
  email: string
  location: string
  bio: string
  createdAt: string
  // Forfait choisi (undefined tant que l'utilisateur n'a pas validé l'étape
  // de choix après inscription).
  plan?: string
}

export type PortalHike = {
  id: string
  ownerId: string
  title: string
  code: string
  status: 'published' | 'draft'
  distanceKm: number
  elevationGain: number
  mediaCount: number
  pointCount: number
  updatedAt: string
  coverUrl?: string
}

export type ProfileExtras = {
  name?: string
  location?: string
  bio?: string
  plan?: string
}
