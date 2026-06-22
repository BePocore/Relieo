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
    video.preload = 'auto'
    let settled = false
    let seekRequested = false
    let seekSettled = false

    const finish = (value: Blob | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
      resolve(value)
    }

    const capture = () => {
      void drawPreview(video, video.videoWidth, video.videoHeight).then(finish)
    }

    type VideoRVFC = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
    }
    const rvfc = (video as VideoRVFC).requestVideoFrameCallback?.bind(video)
    const captureDecodedFrame = () => {
      if (settled) return
      if (rvfc) rvfc(capture)
      else window.setTimeout(capture, 0)
    }
    const canCaptureDecodedFrame = () =>
      !seekRequested || seekSettled || video.currentTime > 0.05

    video.onloadedmetadata = () => {
      try {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          seekRequested = true
          video.currentTime = Math.min(1, Math.max(0, video.duration / 4))
          return
        }
      } catch {
        /* lecture muette en repli */
      }
      captureDecodedFrame()
    }
    video.onloadeddata = () => {
      if (canCaptureDecodedFrame()) captureDecodedFrame()
    }
    video.onseeked = () => {
      seekSettled = true
      captureDecodedFrame()
    }
    video.oncanplay = () => {
      void video.play().then(() => {
        if (canCaptureDecodedFrame()) captureDecodedFrame()
      }).catch(() => {
        if (canCaptureDecodedFrame()) captureDecodedFrame()
      })
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
