import { useEffect, useRef, useState } from 'react'
import maplibregl, { type StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Fond décoratif du hero de connexion : un terrain en relief 3D survolé en
// boucle (rotation lente). Volontairement minimal — pas de marqueurs ni
// d'interaction — et chargé en différé (lazy) pour ne pas alourdir l'écran de
// connexion. L'image CSS de `.auth-visual` reste visible tant qu'il n'a pas
// fini de charger (fondu d'apparition).

const TERRAIN_SOURCE = 'hero-terrain'

const heroStyle = (): StyleSpecification => ({
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
    [TERRAIN_SOURCE]: {
      type: 'raster-dem',
      tiles: [
        'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 14,
      encoding: 'terrarium',
      attribution: 'Elevation tiles by AWS Open Data',
    },
  },
  layers: [
    {
      id: 'satellite',
      type: 'raster',
      source: 'satellite',
      paint: { 'raster-fade-duration': 0, 'raster-saturation': 0.05 },
    },
  ],
})

export default function HeroMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const map = new maplibregl.Map({
      container,
      style: heroStyle(),
      center: [7.6586, 45.9763], // Massif du Cervin (Alpes valaisannes)
      zoom: 12.6,
      pitch: 68,
      bearing: 0,
      interactive: false,
      attributionControl: false,
      renderWorldCopies: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.6),
      canvasContextAttributes: {
        antialias: false,
        powerPreference: 'high-performance',
      },
    })

    let raf = 0
    let bearing = 0
    const spin = () => {
      bearing = (bearing + 0.025) % 360
      map.setBearing(bearing)
      raf = requestAnimationFrame(spin)
    }

    map.on('load', () => {
      map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: 1.4 })
    })
    // Premier rendu stable (tuiles + relief chargés) : on révèle puis on lance
    // la rotation continue.
    map.once('idle', () => {
      setReady(true)
      spin()
    })

    return () => {
      cancelAnimationFrame(raf)
      map.remove()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`auth-map${ready ? ' is-ready' : ''}`}
      aria-hidden="true"
    />
  )
}
