import { useEffect, useMemo, useRef, useState } from 'react'
import { ZoomIn } from 'lucide-react'
import maplibregl, {
  GeoJSONSource,
  LngLatBounds,
  type StyleSpecification,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection, LineString, Point } from 'geojson'
import type { BasemapId } from '../lib/basemaps'
import { simplifyTrack } from '../lib/geo'
import { resolvePointMedia } from '../lib/media'
import { markerDataUri } from '../lib/markers'
import { traceColor } from '../lib/mapStyles'
import type { ImportedMedia, Trace, TrailPoint } from '../types'

export type CameraCommand = {
  id: number
  type:
    | 'turn-left'
    | 'turn-right'
    | 'zoom-in'
    | 'zoom-out'
    | 'tilt-up'
    | 'tilt-down'
}

export type MapLibreTrailMapProps = {
  traces: Trace[]
  points: TrailPoint[]
  mediaLibrary: ImportedMedia[]
  basemap: BasemapId
  recenterRequest: number
  selectedPoint: TrailPoint | null
  cameraCommand: CameraCommand | null
  editable?: boolean
  createPointOnClick?: boolean
  flat2D?: boolean
  // URLs des médias non validés par la modération : marqueur badgé « ! » en
  // studio (le propriétaire les voit ; le public ne les reçoit même pas).
  pendingMediaUrls?: string[]
  videoPosters?: Record<string, string>
  // Plan de journées (lib/days.ts) : jour de chaque point (aligné sur points)
  // et de chaque trace. activeDayKey = jour sélectionné dans la timeline ;
  // les éléments des AUTRES jours sont atténués (les non datés restent pleins)
  // et la caméra vole vers l'emprise du jour.
  pointDayKeys?: Array<string | null>
  traceDayKeys?: Record<string, string | null>
  activeDayKey?: string | null
  onMovePoint?: (pointId: string, lat: number, lng: number) => void
  onCreatePoint?: (lat: number, lng: number) => void
  onMarkerClick: (point: TrailPoint) => void
  onOpenGroup?: (points: TrailPoint[]) => void
  onReady?: () => void
}

type MapMetrics = {
  fps: number | null
  pixelRatio: number
  zoom: number
  pitch: number
  thumbnails: number
}

const terrainSourceId = 'relieo-terrain'
const routeSourceId = 'relieo-routes'
const pointSourceId = 'relieo-points'
const pointLayerId = 'relieo-point-symbols'
const clusterLayerId = 'relieo-point-clusters'
const baseLayerIds = {
  satellite: 'base-satellite',
  topo: 'base-topo',
  streets: 'base-streets',
} as const

const rasterSource = (tiles: string[], attribution: string, maxzoom = 19) => ({
  type: 'raster' as const,
  tiles,
  tileSize: 256,
  maxzoom,
  attribution,
})

const createStyle = (): StyleSpecification => ({
  version: 8,
  sources: {
    'source-satellite': rasterSource(
      [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      'Esri, Maxar, Earthstar Geographics',
    ),
    'source-topo': rasterSource(
      ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
      'OpenTopoMap, OpenStreetMap contributors',
      17,
    ),
    'source-streets': rasterSource(
      ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      'OpenStreetMap contributors',
      19,
    ),
    [terrainSourceId]: {
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
      id: baseLayerIds.satellite,
      type: 'raster',
      source: 'source-satellite',
      layout: { visibility: 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-saturation': 0.06 },
    },
    {
      id: baseLayerIds.topo,
      type: 'raster',
      source: 'source-topo',
      layout: { visibility: 'visible' },
      paint: { 'raster-fade-duration': 0 },
    },
    {
      id: baseLayerIds.streets,
      type: 'raster',
      source: 'source-streets',
      layout: { visibility: 'none' },
      paint: { 'raster-fade-duration': 0 },
    },
  ],
})

const pointKey = (point: TrailPoint, index: number) =>
  point.id ?? `point-${index}`

// Rayon (px écran) en deçà duquel deux vignettes médias sont considérées « en
// tas » : clic → galerie du groupe. ~2/3 de la largeur d'une vignette (82px),
// pour capter les vignettes superposées et celles juste à côté.
const STACK_RADIUS_PX = 54

const emptyPoints = (): FeatureCollection<Point> => ({
  type: 'FeatureCollection',
  features: [],
})

const emptyRoutes = (): FeatureCollection<LineString> => ({
  type: 'FeatureCollection',
  features: [],
})

const boundsFor = (
  traces: Trace[],
  points: TrailPoint[],
) => {
  const bounds = new LngLatBounds()
  for (const trace of traces) {
    for (const point of trace.points) bounds.extend([point.lng, point.lat])
  }
  for (const point of points) bounds.extend([point.lng, point.lat])
  return bounds
}

// Emprise d'un seul jour : traces et points rattachés à cette journée.
const boundsForDay = (
  traces: Trace[],
  points: TrailPoint[],
  traceDayKeys: Record<string, string | null> | undefined,
  pointDayKeys: Array<string | null> | undefined,
  dayKey: string,
) => {
  const bounds = new LngLatBounds()
  for (const trace of traces) {
    if ((traceDayKeys?.[trace.id] ?? null) !== dayKey) continue
    for (const point of trace.points) bounds.extend([point.lng, point.lat])
  }
  points.forEach((point, index) => {
    if ((pointDayKeys?.[index] ?? null) === dayKey) {
      bounds.extend([point.lng, point.lat])
    }
  })
  return bounds
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max))

const loadImage = async (map: maplibregl.Map, id: string, src: string) => {
  if (map.hasImage(id)) return
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    if (!src.startsWith('data:')) element.crossOrigin = 'anonymous'
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error(`Image illisible: ${id}`))
    element.src = src
  })
  if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 1 })
}

const loadHtmlImage = (src: string, alt: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.alt = alt
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Apercu illisible: ${alt}`))
    image.src = src
  })

const routeGeoJson = (
  traces: Trace[],
  compact: boolean,
): FeatureCollection<LineString> => ({
  type: 'FeatureCollection',
  features: traces.flatMap((trace, index) => {
    const simplified = simplifyTrack(
      trace.points,
      compact ? 3.5 : 1.8,
      compact ? 1_200 : 2_800,
    )
    if (simplified.length < 2) return []
    return [
      {
        type: 'Feature',
        properties: {
          id: trace.id,
          color: trace.color ?? traceColor(index),
        },
        geometry: {
          type: 'LineString',
          coordinates: simplified.map((point) => [point.lng, point.lat]),
        },
      },
    ]
  }),
})

export function MapLibreTrailMap({
  traces,
  points,
  mediaLibrary,
  basemap,
  recenterRequest,
  selectedPoint,
  cameraCommand,
  editable = false,
  createPointOnClick = false,
  flat2D = false,
  pendingMediaUrls,
  videoPosters = {},
  pointDayKeys,
  traceDayKeys,
  activeDayKey = null,
  onMovePoint,
  onCreatePoint,
  onMarkerClick,
  onOpenGroup,
  onReady,
}: MapLibreTrailMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const domMarkersRef = useRef<maplibregl.Marker[]>([])
  const pointsRef = useRef(points)
  const basemapRef = useRef(basemap)
  const flat2DRef = useRef(flat2D)
  const createPointOnClickRef = useRef(createPointOnClick)
  const activeDayKeyRef = useRef<string | null>(activeDayKey)
  const prevActiveDayRef = useRef<string | null>(null)
  const pointFeaturesRef = useRef<Array<Feature<Point>>>([])
  const routeFeaturesRef = useRef<Array<Feature<LineString>>>([])
  const callbacksRef = useRef({
    onMovePoint,
    onCreatePoint,
    onMarkerClick,
    onOpenGroup,
    onReady,
  })
  const readyRef = useRef(false)
  // Recalcule la visibilité des vignettes (marqueurs HTML) depuis l'extérieur
  // de l'effet qui les crée, notamment quand le jour sélectionné change.
  const updateMarkerVisibilityRef = useRef<(() => void) | null>(null)
  const [styleReady, setStyleReady] = useState(false)
  // Des ronds de comptage (clusters) sont visibles à l'écran → on invite à
  // zoomer (consultation uniquement).
  const [clustersVisible, setClustersVisible] = useState(false)
  const compact = useMemo(
    () =>
      window.matchMedia('(pointer: coarse)').matches ||
      Math.min(window.screen.width, window.screen.height) <= 820,
    [],
  )
  const [metrics, setMetrics] = useState<MapMetrics>({
    fps: null,
    pixelRatio: 1,
    zoom: 0,
    pitch: 0,
    thumbnails: 0,
  })
  const selectedPointFocusId = selectedPoint?.id ?? selectedPoint?.title ?? null
  const selectedPointLat = selectedPoint?.lat
  const selectedPointLng = selectedPoint?.lng

  useEffect(() => {
    pointsRef.current = points
    basemapRef.current = basemap
    flat2DRef.current = flat2D
    createPointOnClickRef.current = createPointOnClick
    activeDayKeyRef.current = activeDayKey ?? null
    callbacksRef.current = {
      onMovePoint,
      onCreatePoint,
      onMarkerClick,
      onOpenGroup,
      onReady,
    }
  }, [
    points,
    basemap,
    flat2D,
    createPointOnClick,
    activeDayKey,
    onMovePoint,
    onCreatePoint,
    onMarkerClick,
    onOpenGroup,
    onReady,
  ])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const desiredPixelRatio = Math.min(
      window.devicePixelRatio || 1,
      compact ? 1.25 : 1.75,
    )
    const map = new maplibregl.Map({
      container,
      style: createStyle(),
      center: [2.35, 48.85],
      zoom: 11,
      pitch: flat2DRef.current ? 0 : compact ? 46 : 52,
      bearing: flat2DRef.current ? 0 : 22,
      minZoom: 7,
      maxZoom: 18,
      maxPitch: 72,
      pixelRatio: desiredPixelRatio,
      maxTileCacheSize: compact ? 70 : 150,
      fadeDuration: 0,
      renderWorldCopies: false,
      attributionControl: {},
      canvasContextAttributes: {
        antialias: false,
        powerPreference: 'high-performance',
      },
    })
    mapRef.current = map
    map.touchZoomRotate.enable()
    map.touchPitch.enable()
    map.dragRotate.enable()

    let moveFrames = 0
    let moveStartedAt = 0
    const updateMetrics = (fps: number | null = null) => {
      setMetrics((current) => ({
        fps,
        pixelRatio: map.getPixelRatio(),
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        thumbnails: current.thumbnails,
      }))
    }
    const handleMoveStart = () => {
      moveFrames = 0
      moveStartedAt = performance.now()
    }
    const handleRender = () => {
      if (map.isMoving()) moveFrames += 1
    }
    const handleMoveEnd = () => {
      const elapsed = performance.now() - moveStartedAt
      updateMetrics(elapsed > 80 ? Math.round((moveFrames * 1000) / elapsed) : null)
    }
    map.on('movestart', handleMoveStart)
    map.on('render', handleRender)
    map.on('moveend', handleMoveEnd)

    map.on('load', () => {
      for (const [id, layerId] of Object.entries(baseLayerIds)) {
        map.setLayoutProperty(
          layerId,
          'visibility',
          id === basemapRef.current ? 'visible' : 'none',
        )
      }
      map.setTerrain(
        flat2DRef.current
          ? null
          : { source: terrainSourceId, exaggeration: compact ? 1.12 : 1.2 },
      )

      map.addSource(routeSourceId, { type: 'geojson', data: emptyRoutes() })
      map.addLayer({
        id: 'route-outline',
        type: 'line',
        source: routeSourceId,
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 13, 7, 17, 10],
          // dim = trace d'un autre jour que celui sélectionné dans la timeline.
          'line-opacity': [
            'case',
            ['boolean', ['get', 'dim'], false],
            0.14,
            0.92,
          ],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })
      map.addLayer({
        id: 'route-main',
        type: 'line',
        source: routeSourceId,
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#145c4f'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 13, 4.5, 17, 7],
          'line-opacity': ['case', ['boolean', ['get', 'dim'], false], 0.16, 1],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      })

      map.addSource(pointSourceId, {
        type: 'geojson',
        data: emptyPoints(),
        cluster: true,
        clusterRadius: compact ? 58 : 48,
        clusterMaxZoom: 14,
      })
      map.addLayer({
        id: clusterLayerId,
        type: 'circle',
        source: pointSourceId,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#0c1814',
          'circle-radius': ['step', ['get', 'point_count'], 19, 8, 23, 20, 28],
          'circle-stroke-color': '#74dea0',
          'circle-stroke-width': 3,
          'circle-opacity': 0.94,
        },
      })
      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: pointSourceId,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 13,
        },
        paint: { 'text-color': '#ffffff' },
      })
      map.addLayer({
        id: 'selected-halo',
        type: 'circle',
        source: pointSourceId,
        filter: ['==', ['get', 'selected'], true],
        paint: {
          'circle-radius': 30,
          'circle-color': 'rgba(116, 222, 160, 0.16)',
          'circle-stroke-color': '#74dea0',
          'circle-stroke-width': 3,
        },
      })
      map.addLayer({
        id: pointLayerId,
        type: 'symbol',
        source: pointSourceId,
        filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': 0.72,
          'icon-anchor': 'center',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': ['case', ['boolean', ['get', 'dim'], false], 0.18, 1],
        },
      })

      map.on('click', clusterLayerId, async (event) => {
        const feature = event.features?.[0]
        const clusterId = Number(feature?.properties?.cluster_id)
        if (!Number.isFinite(clusterId)) return
        const source = map.getSource(pointSourceId) as GeoJSONSource
        const leaves = await source.getClusterLeaves(clusterId, 100, 0)
        const group = leaves
          .map((leaf) =>
            pointsRef.current.find(
              (point, index) => pointKey(point, index) === leaf.properties?.pointId,
            ),
          )
          .filter((point): point is TrailPoint => Boolean(point))
        if (group.length > 0) callbacksRef.current.onOpenGroup?.(group)
      })

      map.on('click', pointLayerId, (event) => {
        const pointId = event.features?.[0]?.properties?.pointId
        const point = pointsRef.current.find(
          (candidate, index) => pointKey(candidate, index) === pointId,
        )
        if (point) callbacksRef.current.onMarkerClick(point)
      })

      map.on('mouseenter', pointLayerId, () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', pointLayerId, () => {
        map.getCanvas().style.cursor = ''
      })

      if (editable) {
        map.doubleClickZoom.disable()
        map.on('click', (event) => {
          if (!createPointOnClickRef.current) return
          const blockedFeatures = map.queryRenderedFeatures(event.point, {
            layers: [clusterLayerId, pointLayerId],
          })
          if (blockedFeatures.length > 0) return
          callbacksRef.current.onCreatePoint?.(event.lngLat.lat, event.lngLat.lng)
        })
        map.on('dblclick', (event) => {
          if (createPointOnClickRef.current) return
          callbacksRef.current.onCreatePoint?.(event.lngLat.lat, event.lngLat.lng)
        })
      }

      setStyleReady(true)
      updateMetrics()
    })

    return () => {
      for (const marker of domMarkersRef.current) marker.remove()
      domMarkersRef.current = []
      map.remove()
      mapRef.current = null
      readyRef.current = false
    }
  }, [compact, editable])

  useEffect(() => {
    const map = mapRef.current
    if (!styleReady || !map?.isStyleLoaded()) return
    for (const [id, layerId] of Object.entries(baseLayerIds)) {
      map.setLayoutProperty(layerId, 'visibility', id === basemap ? 'visible' : 'none')
    }
  }, [basemap, styleReady])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource(routeSourceId) as GeoJSONSource | undefined
    if (!styleReady || !map || !source) return
    // La géométrie (simplification comprise) n'est recalculée qu'ici ; le
    // filtre par jour ne touche ensuite que la propriété `dim` (effet dédié).
    routeFeaturesRef.current = routeGeoJson(traces, compact).features
    source.setData({
      type: 'FeatureCollection',
      features: routeFeaturesRef.current,
    })
  }, [traces, compact, styleReady])

  // Filtre « jour actif » : atténue traces, symboles GPU et marqueurs HTML des
  // autres jours (les éléments non datés restent pleins, décision produit).
  // Ne recrée rien : propriétés GeoJSON + classes CSS seulement.
  useEffect(() => {
    const map = mapRef.current
    if (!styleReady || !map) return
    const active = activeDayKey ?? null

    // Jour sélectionné : on masque les ronds de comptage (clusters) pour ne
    // laisser que les vignettes du jour. Sinon les ronds restent sur le canvas
    // SOUS les vignettes (invisibles pour l'oeil mais comptés par la bulle).
    const clusterVisibility = active !== null ? 'none' : 'visible'
    for (const layerId of [clusterLayerId, 'cluster-count']) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', clusterVisibility)
      }
    }

    for (const marker of domMarkersRef.current) {
      const element = marker.getElement()
      const dayKey = element.dataset.dayKey ?? ''
      element.classList.toggle(
        'day-dim',
        active !== null && dayKey !== '' && dayKey !== active,
      )
    }

    const pointSource = map.getSource(pointSourceId) as
      | GeoJSONSource
      | undefined
    if (pointSource && pointFeaturesRef.current.length > 0) {
      const features = pointFeaturesRef.current.map((feature) => {
        const dayKey = (feature.properties?.dayKey as string | null) ?? null
        return {
          ...feature,
          properties: {
            ...feature.properties,
            dim: active !== null && dayKey !== null && dayKey !== active,
          },
        }
      })
      pointFeaturesRef.current = features
      pointSource.setData({ type: 'FeatureCollection', features })
    }

    const routeSource = map.getSource(routeSourceId) as
      | GeoJSONSource
      | undefined
    if (routeSource && routeFeaturesRef.current.length > 0) {
      const features = routeFeaturesRef.current.map((feature) => {
        const traceId = feature.properties?.id as string | undefined
        const dayKey = traceId ? (traceDayKeys?.[traceId] ?? null) : null
        return {
          ...feature,
          properties: {
            ...feature.properties,
            dim: active !== null && dayKey !== null && dayKey !== active,
          },
        }
      })
      routeFeaturesRef.current = features
      routeSource.setData({ type: 'FeatureCollection', features })
    }

    // Le jour a changé : réaffiche/masque les vignettes en conséquence (le jour
    // actif reste visible même sous le seuil de zoom).
    updateMarkerVisibilityRef.current?.()
  }, [activeDayKey, traceDayKeys, traces, compact, styleReady])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource(pointSourceId) as GeoJSONSource | undefined
    if (!styleReady || !map || !source) return
    let cancelled = false
    const createdMarkers: maplibregl.Marker[] = []

    const updateMarkerVisibility = () => {
      const previewZoom = compact ? 13.5 : 13.2
      const zoomOk = map.getZoom() >= previewZoom
      const activeDay = activeDayKeyRef.current
      for (const marker of createdMarkers) {
        const element = marker.getElement()
        // Jour sélectionné : ses vignettes s'affichent même en dessous du seuil
        // de zoom (quitte à se chevaucher), pour voir les médias du jour plutôt
        // que les ronds de comptage.
        const inActiveDay =
          activeDay !== null && element.dataset.dayKey === activeDay
        element.hidden = !(zoomOk || inActiveDay)
      }
    }
    updateMarkerVisibilityRef.current = updateMarkerVisibility

    const syncPoints = async () => {
      for (const marker of domMarkersRef.current) marker.remove()
      domMarkersRef.current = []

      await Promise.all(
        (['photo', 'video', '360', 'poi'] as const).map((type) =>
          loadImage(map, `marker-${type}`, markerDataUri(type)),
        ),
      )

      const pendingSet = new Set(pendingMediaUrls ?? [])
      const activeDay = activeDayKeyRef.current
      const features: Array<Feature<Point>> = []
      const mediaMarkers: Array<{
        point: TrailPoint
        thumbnailSource: string
        pending: boolean
        dayKey: string | null
      }> = []
      for (let index = 0; index < points.length; index += 1) {
        const point = points[index]
        const id = pointKey(point, index)
        const dayKey = pointDayKeys?.[index] ?? null
        const media = resolvePointMedia(point, mediaLibrary)
        const thumbnailSource =
          media?.kind === 'image'
            ? (media.thumbnailSrc ?? media.src)
            : media?.kind === 'video'
              ? (media.thumbnailSrc ?? videoPosters[media.src])
              : undefined
        // Média non validé par la modération : badge « ! » (studio seulement).
        const mediaUrl = point.image ?? point.video
        const pending = Boolean(editable && mediaUrl && pendingSet.has(mediaUrl))
        if (thumbnailSource) {
          mediaMarkers.push({ point, thumbnailSource, pending, dayKey })
        }
        features.push({
          type: 'Feature',
          properties: {
            pointId: id,
            icon: `marker-${point.type}`,
            thumbnail: Boolean(thumbnailSource),
            hasMedia: Boolean(media),
            dayKey,
            dim: activeDay !== null && dayKey !== null && dayKey !== activeDay,
            selected: selectedPoint?.id
              ? selectedPoint.id === point.id
              : selectedPoint === point,
          },
          geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        })
      }

      let cursor = 0
      const createMarker = async () => {
        while (!cancelled && cursor < mediaMarkers.length) {
          const job = mediaMarkers[cursor]
          cursor += 1
          try {
            const image = await loadHtmlImage(job.thumbnailSource, job.point.title)
            if (cancelled) return
            const element = document.createElement('button')
            element.type = 'button'
            element.className = `maplibre-photo-marker type-${job.point.type}`
            element.setAttribute('aria-label', `Voir ${job.point.title}`)
            element.dataset.dayKey = job.dayKey ?? ''
            if (
              activeDayKeyRef.current !== null &&
              job.dayKey !== null &&
              job.dayKey !== activeDayKeyRef.current
            ) {
              element.classList.add('day-dim')
            }
            if (selectedPoint?.id && selectedPoint.id === job.point.id) {
              element.classList.add('selected')
            }
            image.draggable = false
            element.appendChild(image)
            if (job.pending) {
              const badge = document.createElement('span')
              badge.className = 'marker-mod-badge'
              badge.setAttribute('aria-hidden', 'true')
              badge.title = 'Modération en cours, non visible du public'
              badge.textContent = '!'
              element.appendChild(badge)
            }
            element.addEventListener('click', (event) => {
              event.stopPropagation()
              // Médias « en tas » : en consultation, si d'autres vignettes sont
              // superposées / très proches à l'écran, on ouvre une galerie
              // défilable du tas (le média cliqué en tête) au lieu du seul
              // média. On ne touche PAS à l'affichage de la carte. En studio,
              // le clic garde sa fonction d'édition (sélection du point).
              const stack: TrailPoint[] = []
              if (!editable) {
                const origin = map.project([job.point.lng, job.point.lat])
                for (const other of mediaMarkers) {
                  if (other.point === job.point) continue
                  const projected = map.project([
                    other.point.lng,
                    other.point.lat,
                  ])
                  const dx = projected.x - origin.x
                  const dy = projected.y - origin.y
                  if (Math.hypot(dx, dy) <= STACK_RADIUS_PX) {
                    stack.push(other.point)
                  }
                }
              }
              if (stack.length > 0 && callbacksRef.current.onOpenGroup) {
                callbacksRef.current.onOpenGroup([job.point, ...stack])
              } else {
                callbacksRef.current.onMarkerClick(job.point)
              }
            })
            const draggable = editable && job.point.locked === false
            const marker = new maplibregl.Marker({
              element,
              anchor: 'center',
              draggable,
              opacity: 1,
              opacityWhenCovered: 1,
            })
              .setLngLat([job.point.lng, job.point.lat])
              .addTo(map)
            if (draggable && job.point.id) {
              marker.on('dragend', () => {
                const position = marker.getLngLat()
                callbacksRef.current.onMovePoint?.(
                  job.point.id!,
                  position.lat,
                  position.lng,
                )
              })
            }
            createdMarkers.push(marker)
          } catch {
            // Le pin GPU reste visible si un aperçu individuel est indisponible.
          }
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(compact ? 4 : 6, mediaMarkers.length) },
          () => createMarker(),
        ),
      )
      if (cancelled) return
      domMarkersRef.current = createdMarkers
      updateMarkerVisibility()
      map.on('zoom', updateMarkerVisibility)

      if (!cancelled) {
        setMetrics((current) => ({
          ...current,
          thumbnails: createdMarkers.length,
        }))
        map.once('render', () => {
          if (!cancelled && !readyRef.current) {
            readyRef.current = true
            callbacksRef.current.onReady?.()
          }
        })
        pointFeaturesRef.current = features
        source.setData({ type: 'FeatureCollection', features })
        map.triggerRepaint()
      }
    }

    void syncPoints()
    return () => {
      cancelled = true
      map.off('zoom', updateMarkerVisibility)
      for (const marker of createdMarkers) marker.remove()
    }
  }, [
    points,
    mediaLibrary,
    videoPosters,
    selectedPoint,
    styleReady,
    compact,
    editable,
    pendingMediaUrls,
    pointDayKeys,
  ])

  // Consultation : détecte si des ronds de comptage (clusters) sont visibles à
  // l'écran, pour afficher une bulle « Zoomez pour voir tous les médias ».
  useEffect(() => {
    const map = mapRef.current
    if (!styleReady || !map || editable) {
      setClustersVisible(false)
      return
    }
    const check = () => {
      // Jour sélectionné : les ronds sont masqués (on montre les vignettes) →
      // pas de bulle.
      if (activeDayKey) {
        setClustersVisible(false)
        return
      }
      if (!map.getLayer(clusterLayerId)) return
      const found = map.queryRenderedFeatures({ layers: [clusterLayerId] })
      setClustersVisible(found.length > 0)
    }
    check()
    map.on('moveend', check)
    map.on('idle', check)
    return () => {
      map.off('moveend', check)
      map.off('idle', check)
    }
  }, [styleReady, editable, activeDayKey])

  useEffect(() => {
    const map = mapRef.current
    if (!styleReady || !map?.isStyleLoaded()) return
    map.setTerrain(
      flat2D
        ? null
        : { source: terrainSourceId, exaggeration: compact ? 1.12 : 1.2 },
    )
    map.easeTo({
      pitch: flat2D ? 0 : compact ? 46 : 52,
      bearing: flat2D ? 0 : map.getBearing(),
      duration: 500,
    })
  }, [flat2D, compact, styleReady])

  useEffect(() => {
    const map = mapRef.current
    if (!styleReady || !map || recenterRequest < 0) return
    const bounds = boundsFor(traces, points)
    if (bounds.isEmpty()) return
    const phoneLayout = window.innerWidth < 600
    const duration = recenterRequest === 0 ? 0 : 700
    map.fitBounds(bounds, {
      padding: phoneLayout
        ? { top: 86, right: 18, bottom: 116, left: 18 }
        : compact
          ? { top: 130, right: 52, bottom: 150, left: 52 }
        : { top: 150, right: 130, bottom: 160, left: 130 },
      pitch: 0,
      bearing: 0,
      duration,
      maxZoom: 15,
    })
    const restoreReliefView = () => {
      if (flat2D) return
      map.easeTo({
        pitch: phoneLayout ? 42 : compact ? 46 : 52,
        bearing: 22,
        zoom: phoneLayout ? map.getZoom() - 0.2 : map.getZoom(),
        duration: duration === 0 ? 0 : 380,
      })
    }
    if (duration === 0) queueMicrotask(restoreReliefView)
    else map.once('moveend', restoreReliefView)
  }, [recenterRequest, traces, points, compact, flat2D, styleReady])

  // Vol de caméra vers l'emprise du jour sélectionné dans la timeline (et
  // retour au séjour complet à la désélection). Ne se déclenche que sur un
  // vrai changement de jour, pas quand traces/points bougent.
  useEffect(() => {
    const map = mapRef.current
    const previous = prevActiveDayRef.current
    const active = activeDayKey ?? null
    if (!styleReady || !map) {
      prevActiveDayRef.current = active
      return
    }
    if (active === previous) return
    prevActiveDayRef.current = active
    const bounds = active
      ? boundsForDay(traces, points, traceDayKeys, pointDayKeys, active)
      : boundsFor(traces, points)
    if (bounds.isEmpty()) return
    const phoneLayout = window.innerWidth < 600
    // Un SEUL mouvement, en conservant le pitch/bearing 3D courants : l'ancien
    // enchaînement (fitBounds à plat pitch 0, puis ré-inclinaison) faisait
    // « sauter la carte en haut » au 1er clic. map.stop() coupe un vol encore
    // en cours (évite qu'un recadrage précédent ne se superpose). La grande
    // marge basse laisse la place à la timeline des jours + au rail de médias.
    map.stop()
    map.fitBounds(bounds, {
      padding: phoneLayout
        ? { top: 80, right: 16, bottom: 176, left: 16 }
        : compact
          ? { top: 120, right: 60, bottom: 200, left: 60 }
          : { top: 150, right: 140, bottom: 190, left: 150 },
      duration: 700,
      maxZoom: 15,
    })
  }, [activeDayKey, traces, points, traceDayKeys, pointDayKeys, compact, styleReady])

  useEffect(() => {
    const map = mapRef.current
    if (
      !styleReady ||
      !map ||
      selectedPointLat === undefined ||
      selectedPointLng === undefined
    ) {
      return
    }
    const currentZoom = map.getZoom()
    const focusLngLat: [number, number] = [selectedPointLng, selectedPointLat]
    const terrainElevation = flat2D
      ? 0
      : Math.max(0, map.queryTerrainElevation(focusLngLat) ?? 0)
    const reliefFactor = Math.min(1, terrainElevation / 1_100)
    const minFocusZoom = compact ? 12.2 : 12.8
    const maxFocusZoom = (compact ? 13.4 : 13.8) - reliefFactor * 0.55
    const currentPitch = map.getPitch()
    const maxFocusPitch = (compact ? 42 : 44) - reliefFactor * 7
    const desktopPanelOffset = window.innerWidth >= 1000 ? -220 : 0
    let correctionQueued = false
    let cancelled = false
    let fallbackTimer: number | null = null

    const correctTerrainProjection = () => {
      if (cancelled) return
      const currentMap = mapRef.current
      if (!currentMap) return

      const container = currentMap.getContainer()
      const width = container.clientWidth
      const height = container.clientHeight
      if (width <= 0 || height <= 0) return

      const projectedPoint = currentMap.project(focusLngLat)
      const targetX = clamp(
        width / 2 + desktopPanelOffset,
        compact ? 86 : 116,
        width - (compact ? 86 : 116),
      )
      const targetY = clamp(
        height * (compact ? 0.52 : 0.54),
        compact ? 118 : 136,
        height - (compact ? 150 : 124),
      )
      const deltaX = projectedPoint.x - targetX
      const deltaY = projectedPoint.y - targetY

      if (Math.abs(deltaX) < 24 && Math.abs(deltaY) < 24) return
      currentMap.panBy([deltaX, deltaY], { duration: 240 })
    }

    const queueTerrainProjectionCorrection = () => {
      if (correctionQueued) return
      correctionQueued = true
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(correctTerrainProjection)
      })
    }

    map.easeTo({
      center: focusLngLat,
      zoom:
        currentZoom < minFocusZoom
          ? minFocusZoom
          : Math.min(currentZoom, maxFocusZoom),
      pitch: flat2D
        ? 0
        : currentPitch > 0
          ? Math.min(currentPitch, maxFocusPitch)
          : maxFocusPitch,
      offset: [desktopPanelOffset, 0],
      duration: 520,
    })
    map.once('moveend', queueTerrainProjectionCorrection)
    fallbackTimer = window.setTimeout(queueTerrainProjectionCorrection, 620)

    return () => {
      cancelled = true
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      map.off('moveend', queueTerrainProjectionCorrection)
    }
  }, [
    selectedPointFocusId,
    selectedPointLat,
    selectedPointLng,
    flat2D,
    compact,
    styleReady,
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !cameraCommand) return
    const common = { duration: 320 }
    if (cameraCommand.type === 'turn-left') {
      map.easeTo({ ...common, bearing: map.getBearing() - 22 })
    } else if (cameraCommand.type === 'turn-right') {
      map.easeTo({ ...common, bearing: map.getBearing() + 22 })
    } else if (cameraCommand.type === 'zoom-in') {
      map.easeTo({ ...common, zoom: map.getZoom() + 0.75 })
    } else if (cameraCommand.type === 'zoom-out') {
      map.easeTo({ ...common, zoom: map.getZoom() - 0.75 })
    } else if (cameraCommand.type === 'tilt-up') {
      map.easeTo({ ...common, pitch: Math.min(map.getPitch() + 10, 70) })
    } else if (cameraCommand.type === 'tilt-down') {
      map.easeTo({ ...common, pitch: Math.max(map.getPitch() - 10, 20) })
    }
  }, [cameraCommand])

  return (
    <div
      className={
        createPointOnClick
          ? 'trail-map maplibre-trail-map placement-active'
          : 'trail-map maplibre-trail-map'
      }
    >
      <div ref={containerRef} className="trail-map-canvas" />
      {!editable && clustersVisible ? (
        <div className="maplibre-cluster-hint" role="status">
          <ZoomIn aria-hidden="true" size={15} />
          <span>Zoomez pour voir tous les médias</span>
        </div>
      ) : null}
      {/* Badge de perfs : outil de diagnostic réservé au Studio, masqué pour
          les visiteurs (aucune valeur pour eux, encombre le coin bas-gauche). */}
      {editable ? (
        <div className="maplibre-metrics" aria-label="Performances MapLibre">
          <strong>MapLibre 3D</strong>
          <span>{metrics.fps ? `${metrics.fps} FPS` : 'prêt'}</span>
          <span>{metrics.pixelRatio.toFixed(2)}×</span>
          <span>z{metrics.zoom.toFixed(1)}</span>
          <span>{Math.round(metrics.pitch)}°</span>
          <span>{metrics.thumbnails} photos</span>
        </div>
      ) : null}
    </div>
  )
}
