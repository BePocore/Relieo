import { useEffect, useState } from 'react'
import { resolvePointMedia } from './lib/media'
import type { ImportedMedia, TrailPoint } from './types'

// Cache global des vignettes vidéo (1re image), évite de régénérer.
const posterCache = new Map<string, string>()

const generatePoster = (src: string): Promise<string | null> =>
  new Promise((resolve) => {
    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    // iOS exige les attributs (pas seulement les propriétés) + un élément
    // attaché au DOM et lancé pour décoder une image vers le canvas.
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.preload = 'auto'
    video.style.cssText =
      'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
    document.body.appendChild(video)

    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      try {
        video.pause()
      } catch {
        /* ignore */
      }
      video.removeAttribute('src')
      video.load()
      video.remove()
      resolve(value)
    }

    const capture = () => {
      if (settled) return
      try {
        if (!video.videoWidth) return
        const width = 152
        const height = 112
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) return finish(null)

        const scale = Math.max(
          width / video.videoWidth,
          height / video.videoHeight,
        )
        const drawWidth = video.videoWidth * scale
        const drawHeight = video.videoHeight * scale
        ctx.drawImage(
          video,
          (width - drawWidth) / 2,
          (height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        )

        // Badge lecture (cercle sombre + triangle blanc).
        ctx.fillStyle = 'rgba(8, 14, 11, 0.55)'
        ctx.beginPath()
        ctx.arc(width / 2, height / 2, 22, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.moveTo(width / 2 - 7, height / 2 - 11)
        ctx.lineTo(width / 2 - 7, height / 2 + 11)
        ctx.lineTo(width / 2 + 12, height / 2)
        ctx.closePath()
        ctx.fill()

        finish(canvas.toDataURL('image/jpeg', 0.72))
      } catch {
        finish(null)
      }
    }

    type VideoRVFC = HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
    }
    const rvfc = (video as VideoRVFC).requestVideoFrameCallback?.bind(video)

    // On vise une image après l'intro (souvent noire) du début.
    const seekTarget = () => Math.min(1, (video.duration || 2) / 4)
    const seekToFrame = () => {
      try {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = seekTarget()
        }
      } catch {
        /* la lecture prendra le relais */
      }
    }

    // Capture seulement quand une vraie image est présentée (anti-écran noir).
    let frameTries = 0
    const captureWhenReady = () => {
      if (settled) return
      if (rvfc) {
        const onFrame = () => {
          if (settled) return
          frameTries += 1
          if (video.videoWidth && (video.currentTime > 0.05 || frameTries > 3)) {
            capture()
          } else {
            rvfc(onFrame)
          }
        }
        rvfc(onFrame)
      } else {
        capture()
      }
    }

    video.addEventListener('loadedmetadata', seekToFrame)
    video.addEventListener('seeked', captureWhenReady)

    // iOS : lancer la lecture muette puis capturer la 1re image décodée.
    video.addEventListener('canplay', () => {
      void video.play().then(captureWhenReady).catch(() => {
        captureWhenReady()
      })
    })

    video.addEventListener('error', () => finish(null))
    window.setTimeout(() => finish(null), 9_000)
    video.src = src
    video.load()
  })

export function useVideoPosters(
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
): Record<string, string> {
  const [posters, setPosters] = useState<Record<string, string>>({})

  useEffect(() => {
    const sources = new Set<string>()
    for (const point of points) {
      const media = resolvePointMedia(point, mediaLibrary)
      if (media?.kind === 'video') sources.add(media.src)
    }

    let cancelled = false
    sources.forEach((src) => {
      if (posterCache.has(src)) {
        const cached = posterCache.get(src)
        if (cached) {
          setPosters((current) =>
            current[src] === cached ? current : { ...current, [src]: cached },
          )
        }
        return
      }
      void generatePoster(src).then((dataUrl) => {
        if (cancelled || !dataUrl) return
        posterCache.set(src, dataUrl)
        setPosters((current) => ({ ...current, [src]: dataUrl }))
      })
    })

    return () => {
      cancelled = true
    }
  }, [points, mediaLibrary])

  return posters
}
