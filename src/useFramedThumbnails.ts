import { useEffect, useState } from 'react'
import { resolvePointMedia } from './lib/media'
import type { ImportedMedia, TrailPoint } from './types'

// Cadre cuit dans la vignette (un seul billboard => clustering correct).
const cache = new Map<string, string>()

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

const frameThumbnail = (src: string): Promise<string | null> =>
  new Promise((resolve) => {
    const image = new Image()
    if (!src.startsWith('data:')) image.crossOrigin = 'anonymous'

    image.onload = () => {
      try {
        const scale = 2
        const w = 84 * scale
        const h = 64 * scale
        const border = 4 * scale
        const radius = 11 * scale
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(null)

        // Ombre + cadre blanc.
        ctx.fillStyle = '#ffffff'
        ctx.shadowColor = 'rgba(8, 14, 11, 0.45)'
        ctx.shadowBlur = 5 * scale
        ctx.shadowOffsetY = 2 * scale
        roundRect(ctx, border, border, w - border * 2, h - border * 2, radius)
        ctx.fill()
        ctx.shadowColor = 'transparent'

        // Image en cover dans le cadre intérieur.
        const innerX = border * 2
        const innerY = border * 2
        const innerW = w - border * 4
        const innerH = h - border * 4
        ctx.save()
        roundRect(ctx, innerX, innerY, innerW, innerH, radius - border)
        ctx.clip()
        const cover = Math.max(innerW / image.width, innerH / image.height)
        const dw = image.width * cover
        const dh = image.height * cover
        ctx.drawImage(
          image,
          innerX + (innerW - dw) / 2,
          innerY + (innerH - dh) / 2,
          dw,
          dh,
        )
        ctx.restore()

        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = src
  })

// Renvoie, par source d'affichage (url image ou poster vidéo), la vignette
// encadrée prête pour la carte.
export function useFramedThumbnails(
  points: TrailPoint[],
  mediaLibrary: ImportedMedia[],
  videoPosters: Record<string, string>,
): Record<string, string> {
  const [framed, setFramed] = useState<Record<string, string>>({})

  useEffect(() => {
    const sources = new Set<string>()
    for (const point of points) {
      const media = resolvePointMedia(point, mediaLibrary)
      if (media?.kind === 'image') sources.add(media.src)
      else if (media?.kind === 'video' && videoPosters[media.src]) {
        sources.add(videoPosters[media.src])
      }
    }

    let cancelled = false
    sources.forEach((src) => {
      if (cache.has(src)) {
        const cached = cache.get(src)
        if (cached) {
          setFramed((current) =>
            current[src] === cached ? current : { ...current, [src]: cached },
          )
        }
        return
      }
      void frameThumbnail(src).then((dataUrl) => {
        if (cancelled || !dataUrl) return
        cache.set(src, dataUrl)
        setFramed((current) => ({ ...current, [src]: dataUrl }))
      })
    })

    return () => {
      cancelled = true
    }
  }, [points, mediaLibrary, videoPosters])

  return framed
}
