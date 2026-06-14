import { useEffect, useMemo, useState } from 'react'
import { resolvePointMedia } from './lib/media'
import type { ImportedMedia, TrailPoint } from './types'

// Vignette « carte » cuite dans un seul billboard (clustering correct) :
// photo à coins arrondis, fin liseré blanc + ombre douce. La carte est
// centrée sur sa coordonnée côté carte (billboard verticalOrigin CENTER).
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string | null>>()

// Dimensions logiques de la vignette (avant facteur retina). Réutilisées côté
// carte pour dimensionner le billboard sans déformer l'image.
export const framedCardWidth = 80
export const framedCardHeight = 56
export const framedPad = 5 // marge pour l'ombre
export const framedCanvasWidth = framedCardWidth + framedPad * 2
export const framedCanvasHeight = framedCardHeight + framedPad * 2

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) => {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Dessine la source (photo / poster) en cover dans la carte encadrée.
const drawFramed = (
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): string | null => {
  if (!sourceWidth || !sourceHeight) return null
  const s = 3 // facteur retina
  const w = framedCanvasWidth * s
  const h = framedCanvasHeight * s
  const pad = framedPad * s
  const cardW = framedCardWidth * s
  const cardH = framedCardHeight * s
  const border = 2 * s
  const radius = 9 * s

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Carte blanche + ombre douce.
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(8, 14, 11, 0.35)'
  ctx.shadowBlur = 5 * s
  ctx.shadowOffsetY = 2 * s
  roundRect(ctx, pad, pad, cardW, cardH, radius)
  ctx.fill()
  ctx.restore()

  // Photo en cover dans le liseré.
  ctx.save()
  roundRect(
    ctx,
    pad + border,
    pad + border,
    cardW - border * 2,
    cardH - border * 2,
    radius - border,
  )
  ctx.clip()
  const innerW = cardW - border * 2
  const innerH = cardH - border * 2
  const cover = Math.max(innerW / sourceWidth, innerH / sourceHeight)
  const dw = sourceWidth * cover
  const dh = sourceHeight * cover
  ctx.drawImage(
    source,
    pad + border + (innerW - dw) / 2,
    pad + border + (innerH - dh) / 2,
    dw,
    dh,
  )
  ctx.restore()

  return canvas.toDataURL('image/png')
}

// Repli historique via <img> (si createImageBitmap indisponible ou échoue).
const frameThumbnailViaImage = (src: string): Promise<string | null> =>
  new Promise((resolve) => {
    const image = new Image()
    if (!src.startsWith('data:')) image.crossOrigin = 'anonymous'
    image.onload = () => {
      try {
        resolve(drawFramed(image, image.width, image.height))
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = src
  })

// Chemin préféré : createImageBitmap décode hors thread principal et le bitmap
// est libéré (close) immédiatement après le dessin → moins de pression mémoire.
const frameThumbnail = async (src: string): Promise<string | null> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const response = await fetch(src, { mode: 'cors' })
      if (response.ok) {
        const blob = await response.blob()
        const bitmap = await createImageBitmap(blob)
        try {
          return drawFramed(bitmap, bitmap.width, bitmap.height)
        } finally {
          bitmap.close()
        }
      }
    } catch {
      /* repli ci-dessous */
    }
  }
  return frameThumbnailViaImage(src)
}

// File à concurrence limitée : on ne décode jamais trop d'images en même temps
// (évite les pics mémoire / la saccade lors d'un gros lot de photos).
const maxConcurrentFraming = 3
let activeFraming = 0
const framingQueue: Array<() => void> = []

const scheduleFraming = (src: string): Promise<string | null> =>
  new Promise((resolve) => {
    const run = () => {
      activeFraming += 1
      void frameThumbnail(src)
        .catch(() => null)
        .then((result) => {
          activeFraming -= 1
          resolve(result)
          framingQueue.shift()?.()
        })
    }
    if (activeFraming < maxConcurrentFraming) run()
    else framingQueue.push(run)
  })

const loadFramedThumbnail = (src: string): Promise<string | null> => {
  const cached = cache.get(src)
  if (cached) return Promise.resolve(cached)

  const existing = pending.get(src)
  if (existing) return existing

  const request = scheduleFraming(src).then((dataUrl) => {
    if (dataUrl) cache.set(src, dataUrl)
    pending.delete(src)
    return dataUrl
  })
  pending.set(src, request)
  return request
}

// Renvoie, par source d'affichage (url image ou poster vidéo), la vignette
// encadrée prête pour la carte.
export function useFramedThumbnails(
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
  videoPosters: Record<string, string>,
): { thumbnails: Record<string, string>; ready: boolean } {
  const sources = useMemo(() => {
    const next = new Set<string>()
    for (const point of points) {
      const media = resolvePointMedia(point, mediaLibrary)
      if (media?.kind === 'image') next.add(media.thumbnailSrc ?? media.src)
      else if (media?.kind === 'video' && videoPosters[media.src]) {
        next.add(videoPosters[media.src])
      }
    }
    return [...next]
  }, [points, mediaLibrary, videoPosters])
  const [batch, setBatch] = useState<{
    sources: string[] | null
    thumbnails: Record<string, string>
  }>({ sources: null, thumbnails: {} })
  useEffect(() => {
    let cancelled = false

    const loadBatch = async () => {
      const entries = await Promise.all(
        sources.map(async (src) => [src, await loadFramedThumbnail(src)] as const),
      )
      if (cancelled) return

      const thumbnails: Record<string, string> = {}
      for (const [src, dataUrl] of entries) {
        if (dataUrl) thumbnails[src] = dataUrl
      }
      setBatch({ sources, thumbnails })
    }

    void loadBatch()

    return () => {
      cancelled = true
    }
  }, [sources])

  return {
    thumbnails: batch.thumbnails,
    ready: batch.sources === sources,
  }
}
