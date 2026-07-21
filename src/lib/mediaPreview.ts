import type { MediaKind } from '../types'

const canvasBlob = (
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> => {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

const drawScaled = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
  quality: number,
): Promise<Blob | null> => {
  if (!sourceWidth || !sourceHeight) return Promise.resolve(null)
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvasBlob(canvas, quality)
}

const drawPreview = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Blob | null> => drawScaled(source, sourceWidth, sourceHeight, 640, 420, 0.78)

const imagePreview = async (file: File): Promise<Blob | null> => {
  try {
    const bitmap = await createImageBitmap(file)
    try {
      return await drawPreview(bitmap, bitmap.width, bitmap.height)
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

// Variante d'affichage (~2000 px de long côté, cf. types.ts `ImportedMedia.
// displayUrl`) : ce que la lightbox/le diaporama/le préchargement montrent par
// défaut à la place de l'original brut (souvent 3-5 Mo pour une photo de
// smartphone récent). 2000 px couvre large tout téléphone/tablette et la
// plupart des écrans de bureau ; l'original reste accessible en un clic
// (bouton « Pleine résolution » de la lightbox) pour le zoom ou le grand écran.
// Exporté : la lightbox recalcule la largeur réelle de la variante à partir des
// dimensions d'origine pour déclarer son `srcset`. Une seule source de vérité,
// sinon le navigateur choisirait sur une largeur fausse.
export const DISPLAY_MAX_SIDE = 2000
const DISPLAY_QUALITY = 0.82

const imageDisplayVariant = async (file: File): Promise<Blob | null> => {
  try {
    const bitmap = await createImageBitmap(file)
    try {
      return await drawScaled(
        bitmap,
        bitmap.width,
        bitmap.height,
        DISPLAY_MAX_SIDE,
        DISPLAY_MAX_SIDE,
        DISPLAY_QUALITY,
      )
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

// Dessine la frame vidéo courante dans un canvas et mesure si elle n'est pas (quasi)
// noire. Renvoie un convertisseur paresseux en Blob + l'indicateur de luminosité.
const captureVideoFrame = (
  video: HTMLVideoElement,
): { toBlob: () => Promise<Blob | null>; bright: boolean } | null => {
  const sw = video.videoWidth
  const sh = video.videoHeight
  if (!sw || !sh) return null
  const scale = Math.min(640 / sw, 420 / sh, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  let bright: boolean
  try {
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let sum = 0
    let count = 0
    for (let i = 0; i < data.length; i += 4 * 37) {
      sum += data[i] + data[i + 1] + data[i + 2]
      count += 1
    }
    bright = count === 0 || sum / (count * 3) >= 12
  } catch {
    // Canvas « tainted » (source cross-origin) : mesure impossible, on suppose OK.
    bright = true
  }
  return { toBlob: () => canvasBlob(canvas, 0.78), bright }
}

// Poster vidéo robuste : on essaie plusieurs instants croissants (intro souvent
// noire), on capture sur requestAnimationFrame (frame réellement peinte) et on
// retient la première frame non noire (sinon la dernière capturée).
const videoPreview = (file: File): Promise<Blob | null> => {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    let settled = false
    let times: number[] = []
    let attempt = 0
    let lastFrame: (() => Promise<Blob | null>) | null = null

    const finish = (value: Blob | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
      resolve(value)
    }
    const finishWithLast = () => {
      if (lastFrame) void lastFrame().then(finish)
      else finish(null)
    }

    const capture = () => {
      requestAnimationFrame(() => {
        const frame = captureVideoFrame(video)
        if (frame) {
          lastFrame = frame.toBlob
          if (frame.bright) {
            void frame.toBlob().then(finish)
            return
          }
        }
        attempt += 1
        if (attempt < times.length) video.currentTime = times[attempt]
        else finishWithLast()
      })
    }

    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 4
      times = [Math.min(1, d / 4), d * 0.25, d * 0.5, d * 0.75].map((t) =>
        Math.max(0, Math.min(t, d - 0.05)),
      )
      video.currentTime = times[0]
    }
    video.onseeked = capture
    video.onerror = () => finishWithLast()
    window.setTimeout(finishWithLast, 8_000)
    video.src = url
  })
}

export const createMediaPreview = (
  file: File,
  kind: MediaKind,
): Promise<Blob | null> => {
  return kind === 'image' ? imagePreview(file) : videoPreview(file)
}

// Photos uniquement (cf. commentaire au-dessus de `imageDisplayVariant`) : une
// vidéo est déjà servie en Range par le videur, jamais téléchargée d'un bloc,
// donc une variante réduite n'apporterait rien.
export const createDisplayVariant = (
  file: File,
  kind: MediaKind,
): Promise<Blob | null> => {
  return kind === 'image' ? imageDisplayVariant(file) : Promise.resolve(null)
}
