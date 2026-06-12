import { useEffect, useState } from 'react'
import { resolvePointMedia } from './lib/media'
import type { ImportedMedia, TrailPoint } from './types'

// Vignette « carte » cuite dans un seul billboard (clustering correct) :
// photo à coins arrondis, fin liseré blanc + ombre douce, et un point
// d'ancrage relié sous la carte pour matérialiser l'emplacement au sol.
const cache = new Map<string, string>()

// Dimensions logiques de la vignette (avant facteur retina). Réutilisées côté
// carte pour dimensionner le billboard sans déformer l'image.
export const framedCardWidth = 80
export const framedCardHeight = 56
const framedGap = 6 // espace carte → point d'ancrage
const framedDotRadius = 3.5
export const framedPad = 5 // marge pour l'ombre
export const framedCanvasWidth = framedCardWidth + framedPad * 2
export const framedCanvasHeight =
  framedPad + framedCardHeight + framedGap + framedDotRadius * 2

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
        const s = 3 // facteur retina
        const w = framedCanvasWidth * s
        const h = framedCanvasHeight * s
        const pad = framedPad * s
        const cardW = framedCardWidth * s
        const cardH = framedCardHeight * s
        const border = 2 * s
        const radius = 9 * s
        const dotR = framedDotRadius * s
        const cx = w / 2

        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(null)

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
        const cover = Math.max(innerW / image.width, innerH / image.height)
        const dw = image.width * cover
        const dh = image.height * cover
        ctx.drawImage(
          image,
          pad + border + (innerW - dw) / 2,
          pad + border + (innerH - dh) / 2,
          dw,
          dh,
        )
        ctx.restore()

        // Connecteur + point d'ancrage au sol (bas-centre du canvas).
        const dotY = h - dotR
        ctx.strokeStyle = 'rgba(12, 21, 18, 0.85)'
        ctx.lineWidth = 2.5 * s
        ctx.beginPath()
        ctx.moveTo(cx, pad + cardH)
        ctx.lineTo(cx, dotY)
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(cx, dotY, dotR, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(12, 21, 18, 0.9)'
        ctx.fill()
        ctx.lineWidth = 1.5 * s
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()

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
