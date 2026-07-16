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

// Type de carte, choisi à la création (FIGÉ ensuite, décision produit) :
// 'hike' = randonnée/voyage classique (comportement historique complet),
// 'gallery' = exposition de photos SANS trace GPS (les imports de traces et
// tous les affichages distance/dénivelé sont retirés ; les jours et la
// timeline restent, datés par l'EXIF). Extensible plus tard.
export type MapKind = 'hike' | 'gallery'

// Mode de vue de la carte : 'both' = badge Auto/2D/3D actuel (le visiteur
// bascule), '2d' = vue 2D verrouillée partout, '3d' = relief 3D verrouillé.
export type MapViewMode = 'both' | '2d' | '3d'

// Réglages de la carte, persistés dans project.json. Tout est facultatif :
// absent = comportement historique ('hike', 'both', fond topo).
// `defaultBasemap` reprend les ids de lib/basemaps ('satellite'|'topo'|'streets').
export type MapConfig = {
  kind?: MapKind
  viewMode?: MapViewMode
  defaultBasemap?: string
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
  // Ordre personnalisé des médias, par section : clé = date locale du jour
  // ('YYYY-MM-DD'), 'undated', ou 'all' pour une carte d'un seul jour / expo.
  // Valeur = ids de points dans l'ordre voulu. Absent = ordre automatique
  // (le long du tracé). Les ids inconnus sont ignorés, les nouveaux médias
  // non listés passent à la fin de leur section.
  order?: Record<string, string[]>
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
  mapConfig?: MapConfig
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
