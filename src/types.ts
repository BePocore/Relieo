export type PointType = 'photo' | 'video' | '360' | 'poi'

export type MediaKind = 'image' | 'video'

export type TrackPoint = {
  lat: number
  lng: number
  ele?: number
  time?: string
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
}

export type ImportedMedia = {
  id: string
  name: string
  url: string
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
  mediaLibrary?: ImportedMedia[]
}

export type UploadProgress = {
  fileIndex: number
  fileCount: number
  fileName: string
  percentage: number
}

export type TrailStats = {
  distanceMeters: number
  elevationGainMeters: number
  elevationLossMeters: number
  maxElevationMeters: number | null
  minElevationMeters: number | null
  pointCount: number
}
