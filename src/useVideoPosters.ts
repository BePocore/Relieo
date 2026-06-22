import { useEffect, useMemo, useState } from 'react'
import { resolvePointMedia } from './lib/media'
import { mediaCrossOrigin } from './lib/mediaAccess'
import type { ImportedMedia, TrailPoint } from './types'

// Cache global des vignettes vidéo (1re image), évite de régénérer.
const posterCache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

type VideoSource = {
  src: string
  thumbnailSrc?: string
}

const generatePoster = (src: string): Promise<string | null> =>
  new Promise((resolve) => {
    const video = document.createElement('video')
    video.crossOrigin = mediaCrossOrigin(src)
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
    let seekRequested = false
    let seekSettled = false
    const seekTarget = () => Math.min(1, (video.duration || 2) / 4)
    const seekToFrame = () => {
      try {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          seekRequested = true
          video.currentTime = seekTarget()
          return
        }
      } catch {
        /* la lecture prendra le relais */
      }
      captureWhenReady()
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

    const canCaptureDecodedFrame = () =>
      !seekRequested || seekSettled || video.currentTime > 0.05

    video.addEventListener('loadedmetadata', seekToFrame)
    video.addEventListener('loadeddata', () => {
      if (canCaptureDecodedFrame()) captureWhenReady()
    })
    video.addEventListener('seeked', () => {
      seekSettled = true
      captureWhenReady()
    })
    video.addEventListener('timeupdate', () => {
      if (canCaptureDecodedFrame()) captureWhenReady()
    })

    // iOS : lancer la lecture muette puis capturer la 1re image décodée.
    video.addEventListener('canplay', () => {
      void video.play().then(() => {
        if (canCaptureDecodedFrame()) captureWhenReady()
      }).catch(() => {
        if (canCaptureDecodedFrame()) captureWhenReady()
      })
    })

    video.addEventListener('error', () => finish(null))
    window.setTimeout(() => finish(null), 9_000)
    video.src = src
    video.load()
  })

// File à concurrence limitée : chaque capture attache un <video> au DOM et lit
// le flux, donc on n'en lance que quelques-unes à la fois (anti-saccade / mémoire).
const maxConcurrentPosters = 2
let activePosters = 0
const posterQueue: Array<() => void> = []

const schedulePoster = (src: string): Promise<string | null> =>
  new Promise((resolve) => {
    const run = () => {
      activePosters += 1
      void generatePoster(src)
        .catch(() => null)
        .then((result) => {
          activePosters -= 1
          resolve(result)
          posterQueue.shift()?.()
        })
    }
    if (activePosters < maxConcurrentPosters) run()
    else posterQueue.push(run)
  })

const loadVideoPoster = (src: string): Promise<string | null> => {
  const cached = posterCache.get(src)
  if (cached) return Promise.resolve(cached)

  const existing = pending.get(src)
  if (existing) return existing

  const request = schedulePoster(src).then((dataUrl) => {
    if (dataUrl) posterCache.set(src, dataUrl)
    pending.delete(src)
    return dataUrl
  })
  pending.set(src, request)
  return request
}

export function useVideoPosters(
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
): { posters: Record<string, string>; ready: boolean } {
  const sources = useMemo(() => {
    const next = new Map<string, VideoSource>()
    for (const point of points) {
      const media = resolvePointMedia(point, mediaLibrary)
      if (media?.kind === 'video') {
        next.set(media.src, { src: media.src, thumbnailSrc: media.thumbnailSrc })
      }
    }
    return [...next.values()]
  }, [points, mediaLibrary])
  const [batch, setBatch] = useState<{
    sources: VideoSource[] | null
    posters: Record<string, string>
  }>({ sources: null, posters: {} })
  useEffect(() => {
    let cancelled = false

    const loadBatch = async () => {
      const fallbackPosters: Record<string, string> = {}
      for (const { src, thumbnailSrc } of sources) {
        if (thumbnailSrc) fallbackPosters[src] = thumbnailSrc
      }
      if (
        sources.length > 0 &&
        Object.keys(fallbackPosters).length === sources.length
      ) {
        setBatch({ sources, posters: fallbackPosters })
      }

      const entries = await Promise.all(
        sources.map(async ({ src, thumbnailSrc }) => {
          const poster = await loadVideoPoster(src)
          return [src, poster ?? thumbnailSrc ?? null] as const
        }),
      )
      if (cancelled) return

      const posters: Record<string, string> = { ...fallbackPosters }
      for (const [src, dataUrl] of entries) {
        if (dataUrl) posters[src] = dataUrl
      }
      setBatch({ sources, posters })
    }

    void loadBatch()

    return () => {
      cancelled = true
    }
  }, [sources])

  return {
    posters: batch.posters,
    ready: batch.sources === sources,
  }
}
