import exifr from 'exifr'
import type { ImportedMedia, MediaKind, TrailPoint } from '../types'

const directUrlPattern = /^(blob:|data:|https?:\/\/|\/)/
const heicExtensionPattern = /\.(heic|heif)$/i
const videoExtensionPattern = /\.(mp4|m4v|mov)$/i

export const mediaKindFromFile = (file: File): MediaKind | null => {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (heicExtensionPattern.test(file.name)) return 'image'
  if (videoExtensionPattern.test(file.name)) return 'video'
  return null
}

export const fileNameFromPath = (path: string): string => {
  const cleanPath = path.split('?')[0].split('#')[0]
  return decodeURIComponent(cleanPath.split(/[\\/]/).pop() ?? cleanPath)
}

export const resolvePointMedia = (
  point: TrailPoint,
  mediaLibrary: ImportedMedia[],
): {
  src: string
  kind: MediaKind
  name?: string
  thumbnailSrc?: string
  width?: number
  height?: number
  durationSeconds?: number
} | null => {
  const source = point.video ?? point.image
  const kind: MediaKind =
    point.mediaKind ?? (point.video || point.type === 'video' ? 'video' : 'image')

  if (point.mediaName) {
    const media = mediaLibrary.find(
      (item) => item.name.toLowerCase() === point.mediaName?.toLowerCase(),
    )
    if (media) {
      return {
        src: media.url,
        kind: media.kind,
        name: media.name,
        thumbnailSrc: media.thumbnailUrl,
        width: media.width,
        height: media.height,
        durationSeconds: media.durationSeconds,
      }
    }
  }

  if (!source) return null

  const mediaByUrl = mediaLibrary.find((item) => item.url === source)
  if (mediaByUrl) {
    return {
      src: mediaByUrl.url,
      kind: mediaByUrl.kind,
      name: mediaByUrl.name,
      thumbnailSrc: mediaByUrl.thumbnailUrl,
      width: mediaByUrl.width,
      height: mediaByUrl.height,
      durationSeconds: mediaByUrl.durationSeconds,
    }
  }

  const sourceName = fileNameFromPath(source).toLowerCase()
  const media = mediaLibrary.find(
    (item) => item.name.toLowerCase() === sourceName,
  )
  if (media) {
    return {
      src: media.url,
      kind: media.kind,
      name: media.name,
      thumbnailSrc: media.thumbnailUrl,
      width: media.width,
      height: media.height,
      durationSeconds: media.durationSeconds,
    }
  }

  if (directUrlPattern.test(source) || source.includes('/')) {
    return { src: source, kind, name: fileNameFromPath(source) }
  }

  return { src: source, kind, name: source }
}

const iso6709Pattern =
  /([+-](?:[0-8]\d|90)(?:\.\d+)?)([+-](?:(?:0?\d{1,2})|1[0-7]\d|180)(?:\.\d+)?)(?:[+-]\d+(?:\.\d+)?)?\//g
const gpsTextKeys = [
  'GPSCoordinates',
  'GpsCoordinates',
  'Location',
  'location',
]
const latitudeKeys = [
  'GPSLatitude',
  'GpsLatitude',
  'gpsLatitude',
  'Latitude',
  'latitude',
]
const longitudeKeys = [
  'GPSLongitude',
  'GpsLongitude',
  'GpsLongtitude',
  'gpsLongitude',
  'Longitude',
  'Longtitude',
  'longitude',
]

const safeDateString = (value: unknown): string | undefined => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString()
  }

  return undefined
}

const safeNumber = (value: unknown): number | undefined => {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined
  return Math.round(numberValue)
}

const isValidCoordinate = (lat: number, lng: number): boolean => {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  )
}

const escapedPattern = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const decodeMetadataText = (buffer: ArrayBuffer): string => {
  return new TextDecoder('latin1')
    .decode(buffer)
    .replace(/\0/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x2B;|&#43;/gi, '+')
    .replace(/&#x2D;|&#45;/gi, '-')
    .replace(/\s+/g, ' ')
}

const parseFraction = (value: string): number => {
  const [numerator, denominator] = value.split('/').map(Number)
  if (denominator) return numerator / denominator
  return numerator
}

const coordinateFromValue = (
  value: string,
  axis: 'lat' | 'lng',
): number | null => {
  const cleanValue = value.trim()
  const hemisphere = cleanValue.match(/[NSEW]/i)?.[0]?.toUpperCase()
  const rawParts = cleanValue.match(/[+-]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/g)

  if (!rawParts?.length) return null

  const numbers = rawParts.map(parseFraction).filter(Number.isFinite)
  if (numbers.length === 0) return null

  const hasDmsMarkers = /deg|degree|°|'|"|min|sec/i.test(cleanValue)
  const useDms = numbers.length >= 3 || (numbers.length >= 2 && hasDmsMarkers)
  const signFromValue = numbers[0] < 0 ? -1 : 1
  const sign =
    hemisphere === 'S' || hemisphere === 'W'
      ? -1
      : hemisphere === 'N' || hemisphere === 'E'
        ? 1
        : signFromValue
  const absoluteValue = useDms
    ? Math.abs(numbers[0]) + Math.abs(numbers[1] ?? 0) / 60 + Math.abs(numbers[2] ?? 0) / 3600
    : Math.abs(numbers[0])
  const coordinate = absoluteValue * sign

  if (axis === 'lat' && Math.abs(coordinate) > 90) return null
  if (axis === 'lng' && Math.abs(coordinate) > 180) return null

  return coordinate
}

const firstCoordinateForKeys = (
  text: string,
  keys: string[],
  axis: 'lat' | 'lng',
): number | null => {
  const keyPattern = keys.map(escapedPattern).join('|')
  const patterns = [
    new RegExp(
      `(?:[\\w.-]+:)?(?:${keyPattern})\\s*=\\s*["']([^"']{1,140})["']`,
      'gi',
    ),
    new RegExp(
      `["']?(?:[\\w.-]+:)?(?:${keyPattern})["']?\\s*[:=]\\s*["']?([^"',;<>}\\]]{1,140})`,
      'gi',
    ),
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const coordinate = coordinateFromValue(match[1], axis)
      if (coordinate !== null) return coordinate
    }
  }

  return null
}

const coordinatePairFromTextValue = (
  value: string,
): Pick<ImportedMedia, 'lat' | 'lng' | 'locationSource'> | null => {
  for (const match of value.matchAll(iso6709Pattern)) {
    const lat = Number.parseFloat(match[1])
    const lng = Number.parseFloat(match[2])
    if (isValidCoordinate(lat, lng)) {
      return { lat, lng, locationSource: 'video-metadata' }
    }
  }

  const signedPair = value.match(
    /([+-]?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*([+-]?\d{1,3}(?:\.\d+)?)/,
  )
  if (signedPair) {
    const lat = Number.parseFloat(signedPair[1])
    const lng = Number.parseFloat(signedPair[2])
    if (isValidCoordinate(lat, lng)) {
      return { lat, lng, locationSource: 'video-metadata' }
    }
  }

  const parts = value.split(/[,;]/)
  if (parts.length >= 2) {
    const latPart = parts.find((part) => /[NS]/i.test(part)) ?? parts[0]
    const lngPart = parts.find((part) => /[EW]/i.test(part)) ?? parts[1]
    const lat = coordinateFromValue(latPart, 'lat')
    const lng = coordinateFromValue(lngPart, 'lng')

    if (lat !== null && lng !== null && isValidCoordinate(lat, lng)) {
      return { lat, lng, locationSource: 'video-metadata' }
    }
  }

  return null
}

const coordinatesFromVideoText = (
  text: string,
): Pick<ImportedMedia, 'lat' | 'lng' | 'locationSource'> => {
  const keyPattern = gpsTextKeys.map(escapedPattern).join('|')
  const gpsTextPattern = new RegExp(
    `(?:[\\w.-]+:)?(?:${keyPattern})\\s*=\\s*["']([^"']{1,220})["']`,
    'gi',
  )

  for (const match of text.matchAll(gpsTextPattern)) {
    const coordinates = coordinatePairFromTextValue(match[1])
    if (coordinates) return coordinates
  }

  const lat = firstCoordinateForKeys(text, latitudeKeys, 'lat')
  const lng = firstCoordinateForKeys(text, longitudeKeys, 'lng')

  if (lat !== null && lng !== null && isValidCoordinate(lat, lng)) {
    return { lat, lng, locationSource: 'video-metadata' }
  }

  const coordinates = coordinatePairFromTextValue(text)
  return coordinates ?? {}
}

const extractImageMetadata = async (
  file: File,
): Promise<
  Pick<
    ImportedMedia,
    'height' | 'lat' | 'lng' | 'takenAt' | 'locationSource' | 'width'
  >
> => {
  try {
    const [gps, tags] = await Promise.all([
      exifr.gps(file).catch(() => undefined),
      exifr
        .parse(file, {
          pick: [
            'DateTimeOriginal',
            'CreateDate',
            'ModifyDate',
            'ImageWidth',
            'ImageHeight',
            'ExifImageWidth',
            'ExifImageHeight',
            'PixelXDimension',
            'PixelYDimension',
          ],
        })
        .catch(() => undefined),
    ])

    const width =
      safeNumber(tags?.ImageWidth) ??
      safeNumber(tags?.ExifImageWidth) ??
      safeNumber(tags?.PixelXDimension)
    const height =
      safeNumber(tags?.ImageHeight) ??
      safeNumber(tags?.ExifImageHeight) ??
      safeNumber(tags?.PixelYDimension)

    if (!gps || !isValidCoordinate(gps.latitude, gps.longitude)) {
      return {
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      }
    }

    return {
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      lat: gps.latitude,
      lng: gps.longitude,
      takenAt:
        safeDateString(tags?.DateTimeOriginal) ??
        safeDateString(tags?.CreateDate) ??
        safeDateString(tags?.ModifyDate),
      locationSource: 'exif',
    }
  } catch {
    return {}
  }
}

const readImageDimensions = async (
  url: string,
): Promise<Pick<ImportedMedia, 'height' | 'width'>> => {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      resolve({
        width: image.naturalWidth || undefined,
        height: image.naturalHeight || undefined,
      })
    }
    image.onerror = () => resolve({})
    image.src = url
  })
}

const readVideoDimensions = async (
  url: string,
): Promise<Pick<ImportedMedia, 'durationSeconds' | 'height' | 'width'>> => {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        durationSeconds: Number.isFinite(video.duration)
          ? video.duration
          : undefined,
      })
    }
    video.onerror = () => resolve({})
    video.src = url
  })
}

const extractVideoMetadata = async (
  file: File,
): Promise<Pick<ImportedMedia, 'lat' | 'lng' | 'locationSource'>> => {
  try {
    const sampleSize = Math.min(file.size, 32 * 1024 * 1024)
    const head = await file.slice(0, sampleSize).arrayBuffer()
    const tail =
      file.size > sampleSize
        ? await file.slice(Math.max(file.size - sampleSize, 0)).arrayBuffer()
        : new ArrayBuffer(0)
    const text = `${decodeMetadataText(head)} ${decodeMetadataText(tail)}`
    return coordinatesFromVideoText(text)
  } catch {
    return {}
  }
}

export const createImportedMedia = async (
  file: File,
): Promise<ImportedMedia | null> => {
  const kind = mediaKindFromFile(file)
  if (!kind) return null
  const url = URL.createObjectURL(file)
  const metadata =
    kind === 'image'
      ? await extractImageMetadata(file)
      : await extractVideoMetadata(file)
  const dimensions =
    kind === 'image'
      ? await readImageDimensions(url)
      : await readVideoDimensions(url)

  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    url,
    kind,
    size: file.size,
    ...(file.type ? { mimeType: file.type } : {}),
    ...metadata,
    ...dimensions,
  }
}

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ko`
  return `${(bytes / (1024 * 1024)).toLocaleString('fr-FR', {
    maximumFractionDigits: 1,
  })} Mo`
}

export const formatMediaQuality = (
  media: Pick<ImportedMedia, 'durationSeconds' | 'height' | 'width'> | null,
): string => {
  if (!media?.width || !media.height) return 'qualite inconnue'

  const dimensions = `${media.width.toLocaleString('fr-FR')} x ${media.height.toLocaleString('fr-FR')}`
  if (!media.durationSeconds) return dimensions

  const minutes = Math.floor(media.durationSeconds / 60)
  const seconds = Math.round(media.durationSeconds % 60)
  return `${dimensions} · ${minutes}:${String(seconds).padStart(2, '0')}`
}
