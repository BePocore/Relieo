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

export type TrailProject = {
  points: TrailPoint[]
  pointsSourceName: string
  savedAt: string
  track: TrackPoint[]
  trackSourceName: string
  traces?: Trace[]
  accessCode?: string
  mediaLibrary?: ImportedMedia[]
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
