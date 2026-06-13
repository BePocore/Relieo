import type { MediaKind } from '../types'

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> => {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78))
}

const drawPreview = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Blob | null> => {
  if (!sourceWidth || !sourceHeight) return Promise.resolve(null)
  const maxWidth = 640
  const maxHeight = 420
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) return Promise.resolve(null)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvasBlob(canvas)
}

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

const videoPreview = (file: File): Promise<Blob | null> => {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    let settled = false

    const finish = (value: Blob | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
      resolve(value)
    }

    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, Math.max(0, video.duration / 4))
    }
    video.onseeked = () => {
      void drawPreview(video, video.videoWidth, video.videoHeight).then(finish)
    }
    video.onerror = () => finish(null)
    window.setTimeout(() => finish(null), 8_000)
    video.src = url
  })
}

export const createMediaPreview = (
  file: File,
  kind: MediaKind,
): Promise<Blob | null> => {
  return kind === 'image' ? imagePreview(file) : videoPreview(file)
}
