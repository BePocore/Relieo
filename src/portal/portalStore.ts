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
  // Photo de profil : vignette JPEG (data URL) stockée dans Firestore.
  photoURL?: string
  // Acceptation des CGU (et de la modération IA des médias). Tant que c'est
  // false/undefined, un écran de consentement bloque l'accès au dashboard.
  termsAccepted?: boolean
  termsAcceptedAt?: string
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
  photoURL?: string
  termsAccepted?: boolean
  termsAcceptedAt?: string
}

// État de modération du compte, lu depuis Firestore `moderation/<uid>` (écrit
// seulement par l'admin). Pilote l'écran de blocage / suppression du portail.
export type AccountStatus = {
  status: 'active' | 'blocked' | 'deleted'
  message: string
  appealSent: boolean
  // Réponse de l'admin à l'appel, affichée sur l'écran de blocage.
  adminReply: string | null
  // Demande volontaire de suppression en attente de traitement par l'admin.
  deletionRequested: boolean
}

// Notification déposée par l'admin dans le profil de l'utilisateur, affichée à
// sa prochaine connexion (ex : une de ses cartes a été dépubliée).
export type PortalNotification = {
  id: string
  type:
    | 'unpublish'
    | 'delete'
    | 'block'
    | 'delete-account'
    | 'media-rejected'
    | 'info'
  message: string
  mapTitle?: string
  createdAt: string
  // Lue par l'utilisateur (absent/false = non lue → pastille rouge sur la cloche).
  read?: boolean
}
