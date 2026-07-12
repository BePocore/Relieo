export type PointType = 'photo' | 'video' | '360' | 'poi'

export type MediaKind = 'image' | 'video'

export type TrackPoint = {
  lat: number
  lng: number
  ele?: number
  time?: string
}

export type Trace = {
  id: string
  name: string
  points: TrackPoint[]
  color?: string
  /**
   * Fichier R2 contenant les points (format `{ version, points }`), servi par
   * le videur avec le ticket de la carte. Dans project.json les points ne sont
   * PLUS inline (limite Vercel ~4,5 Mo par requête) : `points` y est vide et
   * la trace est rechargée depuis ce fichier (fidélité brute, zéro perte).
   * Absent sur les anciennes cartes (points inline, rétrocompat au chargement).
   */
  fileUrl?: string
  /** Informatif (affichage/registre) : nombre de points du fichier référencé. */
  pointCount?: number
}

export type TrailPoint = {
  id?: string
  lat: number
  lng: number
  title: string
  type: PointType
  image?: string
  video?: string
  mediaName?: string
  mediaKind?: MediaKind
  skypixelUrl?: string
  description?: string
  altitude?: number
  color?: string
  // Verrou de position (Studio). undefined = verrouillé par défaut ;
  // seul `false` autorise le déplacement. Non persisté.
  locked?: boolean
}

export type ImportedMedia = {
  id: string
  name: string
  url: string
  fingerprint?: string
  thumbnailUrl?: string
  kind: MediaKind
  size: number
  mimeType?: string
  width?: number
  height?: number
  durationSeconds?: number
  lat?: number
  lng?: number
  takenAt?: string
  locationSource?: 'exif' | 'video-metadata'
}

// Réglages du diaporama, édités au Studio (SlideshowEditor). Tout est
// facultatif : absent = comportement automatique historique. `days` est clé
// par la date locale 'YYYY-MM-DD' du jour (stable quand le plan de journées
// se recalcule) ou 'undated' pour la carte « Non datés » ; `media` est clé
// par l'id du point porteur du média.
export type SlideshowDaySettings = {
  title?: string
  intro?: string
}

export type SlideshowMediaSettings = {
  durationMs?: number
  excluded?: boolean
}

export type SlideshowEndCardSettings = {
  enabled?: boolean
  title?: string
}

export type SlideshowSettings = {
  photoMs?: number
  breakMs?: number
  days?: Record<string, SlideshowDaySettings>
  media?: Record<string, SlideshowMediaSettings>
  endCard?: SlideshowEndCardSettings
}

export type TrailProject = {
  points: TrailPoint[]
  pointsSourceName: string
  savedAt: string
  track: TrackPoint[]
  trackSourceName: string
  traces?: Trace[]
  accessCode?: string
  mediaLibrary?: ImportedMedia[]
  slideshow?: SlideshowSettings
}

export type UploadProgress = {
  fileIndex: number
  fileCount: number
  fileName: string
  percentage: number
}

export type ImportReportEntry = {
  name: string
  detail?: string
  mediaId?: string
  placementEstimate?: {
    lat: number
    lng: number
    detail: string
  }
  estimateUnavailable?: boolean
}

export type ImportReport = {
  total: number
  placed: ImportReportEntry[]
  noGps: ImportReportEntry[]
  offTrack: ImportReportEntry[]
  duplicates: ImportReportEntry[]
  failed: ImportReportEntry[]
}

export type TrailStats = {
  distanceMeters: number
  elevationGainMeters: number
  elevationLossMeters: number
  maxElevationMeters: number | null
  minElevationMeters: number | null
  pointCount: number
}
