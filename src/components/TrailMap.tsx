import { useEffect, useMemo, useRef } from 'react'
import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  BoundingSphere,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  CustomDataSource,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  HeightReference,
  HorizontalOrigin,
  ImageryLayer,
  Ion,
  KeyboardEventModifier,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  OpenStreetMapImageryProvider,
  Rectangle,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
  defined,
  type Entity,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { ImportedMedia, Trace, TrailPoint, TrackPoint } from '../types'
import { simplifyTrack } from '../lib/geo'
import { markerDataUri } from '../lib/markers'
import { resolvePointMedia } from '../lib/media'
import {
  framedCanvasHeight,
  framedCanvasWidth,
  framedCardHeight,
  framedCardWidth,
} from '../useFramedThumbnails'
import { cesiumIonToken, useWorldTerrain } from '../lib/terrain'
import type { BasemapId } from '../lib/basemaps'

if (cesiumIonToken) Ion.defaultAccessToken = cesiumIonToken

type TrailMapProps = {
  traces: Trace[]
  points: TrailPoint[]
  mediaLibrary: ImportedMedia[]
  basemap: BasemapId
  recenterRequest: number
  selectedPoint: TrailPoint | null
  cameraCommand: CameraCommand | null
  editable?: boolean
  videoPosters?: Record<string, string>
  framedThumbnails?: Record<string, string>
  onMovePoint?: (pointId: string, lat: number, lng: number) => void
  onCreatePoint?: (lat: number, lng: number) => void
  onMarkerClick: (point: TrailPoint) => void
  onOpenGroup?: (points: TrailPoint[]) => void
}

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

const routeOuterColor = Color.fromCssColorString('#ffffff')

// Palette partagée (traces et points) — 12 couleurs, réutilisée dans le Studio.
export const paletteColors = [
  '#f4512c',
  '#3cdc8c',
  '#3b82f6',
  '#f59e0b',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#14b8a6',
  '#eab308',
  '#8b5cf6',
  '#06b6d4',
  '#f97316',
]

export const traceColor = (index: number): string =>
  paletteColors[index % paletteColors.length]

// Icône d'un groupe de vignettes qui se chevauchent (pile de photos).
const clusterStackUri = (() => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="52" viewBox="0 0 56 52">` +
    `<rect x="16" y="4" width="34" height="26" rx="6" fill="#fff" stroke="rgba(8,14,11,0.32)" stroke-width="1.5"/>` +
    `<rect x="10" y="11" width="36" height="28" rx="6" fill="#fff" stroke="rgba(8,14,11,0.34)" stroke-width="1.5"/>` +
    `<rect x="5" y="19" width="40" height="30" rx="7" fill="#fff" stroke="rgba(8,14,11,0.4)" stroke-width="1.5"/>` +
    `</svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
})()

// Pin coloré pour un point personnalisé (sans glyphe de type).
export const coloredMarkerDataUri = (color: string): string => {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="58" viewBox="0 0 48 58">
      <path fill="rgba(14, 23, 35, 0.25)" d="M24 58c6.5 0 11.8-1.5 11.8-3.4S30.5 51.2 24 51.2 12.2 52.8 12.2 54.6 17.5 58 24 58Z"/>
      <path fill="${color}" stroke="#fff" stroke-width="3" d="M24 3C13.5 3 5 11.3 5 21.6 5 36.3 24 54 24 54s19-17.7 19-32.4C43 11.3 34.5 3 24 3Z"/>
      <circle cx="24" cy="22" r="9" fill="rgba(255,255,255,0.96)"/>
    </svg>
  `
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

const combineTracePoints = (traces: Trace[]): TrackPoint[] =>
  traces.flatMap((trace) => trace.points)

// Billboard dimensionné sur le canvas de la vignette encadrée (carte + ancrage).
const thumbnailFrameWidth = framedCanvasWidth
const thumbnailFrameHeight = framedCanvasHeight
// Échelle plus stable selon le zoom (1 → 0.85) pour des vignettes homogènes.
const thumbnailScaleByDistance = new NearFarScalar(1_000, 1, 160_000, 0.85)
const arcGisTerrainUrl =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

const computeBounds = (track: TrackPoint[], points: TrailPoint[]): Rectangle => {
  const coordinates = [
    ...track.map(({ lat, lng }) => ({ lat, lng })),
    ...points.map(({ lat, lng }) => ({ lat, lng })),
  ]

  if (coordinates.length === 0) {
    return Rectangle.fromDegrees(2.25, 48.8, 2.45, 48.95)
  }

  const lats = coordinates.map((point) => point.lat)
  const lngs = coordinates.map((point) => point.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const latPadding = Math.max((maxLat - minLat) * 0.24, 0.008)
  const lngPadding = Math.max((maxLng - minLng) * 0.24, 0.008)

  return Rectangle.fromDegrees(
    minLng - lngPadding,
    minLat - latPadding,
    maxLng + lngPadding,
    maxLat + latPadding,
  )
}

const pointEntityId = (point: TrailPoint, index: number): string =>
  `trail-point-${point.id ?? index}`

const flyToTrail = (
  viewer: Viewer,
  track: TrackPoint[],
  points: TrailPoint[],
  duration: number,
) => {
  const positions = (track.length > 0 ? track : points).map((point) =>
    Cartesian3.fromDegrees(point.lng, point.lat, 0),
  )

  if (positions.length === 0) {
    viewer.camera.flyTo({ destination: computeBounds(track, points), duration })
    viewer.scene.requestRender()
    return
  }

  const sphere = BoundingSphere.fromPoints(positions)
  viewer.camera.flyToBoundingSphere(sphere, {
    duration,
    offset: new HeadingPitchRange(
      CesiumMath.toRadians(24),
      CesiumMath.toRadians(-52),
      Math.max(sphere.radius * 4.8, 2_500),
    ),
  })
  viewer.scene.requestRender()
}

const createBaseLayer = (basemap: BasemapId): ImageryLayer => {
  if (basemap === 'satellite') {
    return ImageryLayer.fromProviderAsync(
      ArcGisMapServerImageryProvider.fromUrl(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        { enablePickFeatures: false },
      ),
    )
  }

  if (basemap === 'topo') {
    return new ImageryLayer(
      new UrlTemplateImageryProvider({
        url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
        credit: '© OpenTopoMap contributors',
      }),
    )
  }

  return new ImageryLayer(
    new OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
    }),
  )
}

export function TrailMap({
  traces,
  points,
  mediaLibrary,
  basemap,
  recenterRequest,
  selectedPoint,
  cameraCommand,
  editable = false,
  videoPosters = {},
  framedThumbnails = {},
  onMovePoint,
  onCreatePoint,
  onMarkerClick,
  onOpenGroup,
}: TrailMapProps) {
  const track = useMemo(() => combineTracePoints(traces), [traces])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointSourceRef = useRef<CustomDataSource | null>(null)
  const poiSourceRef = useRef<CustomDataSource | null>(null)
  const pointsByEntityId = useRef(new Map<string, TrailPoint>())
  const onMarkerClickRef = useRef(onMarkerClick)
  const onMovePointRef = useRef(onMovePoint)
  const onCreatePointRef = useRef(onCreatePoint)
  const onOpenGroupRef = useRef(onOpenGroup)
  const editableRef = useRef(editable)
  const selectedKeyRef = useRef<string | null>(null)
  const didInitialFitRef = useRef(false)
  const mediaLibraryRef = useRef(mediaLibrary)
  const videoPostersRef = useRef(videoPosters)
  const framedThumbnailsRef = useRef(framedThumbnails)

  useEffect(() => {
    onMarkerClickRef.current = onMarkerClick
    onMovePointRef.current = onMovePoint
    onCreatePointRef.current = onCreatePoint
    onOpenGroupRef.current = onOpenGroup
    editableRef.current = editable
    mediaLibraryRef.current = mediaLibrary
    videoPostersRef.current = videoPosters
    framedThumbnailsRef.current = framedThumbnails
  }, [editable, onMovePoint, onCreatePoint, onMarkerClick, onOpenGroup, mediaLibrary, videoPosters, framedThumbnails])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.replaceChildren()
    didInitialFitRef.current = false
    const coarsePointer =
      window.matchMedia('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0
    const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1)
    const targetPixelRatio = Math.min(devicePixelRatio, coarsePointer ? 2 : 2.25)

    const viewer = new Viewer(container, {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      shouldAnimate: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
      msaaSamples: coarsePointer ? 2 : 4,
      useBrowserRecommendedResolution: false,
      contextOptions: {
        webgl: {
          antialias: true,
          powerPreference: 'high-performance',
        },
      },
    })

    viewer.resolutionScale = targetPixelRatio / devicePixelRatio
    container.dataset.renderDpr = targetPixelRatio.toFixed(2)
    viewer.scene.postProcessStages.fxaa.enabled = true
    viewer.scene.globe.maximumScreenSpaceError = coarsePointer ? 2 : 1.5
    viewer.scene.globe.tileCacheSize = coarsePointer ? 260 : 420
    viewer.scene.globe.preloadAncestors = true
    viewer.scene.globe.preloadSiblings = true
    viewer.scene.globe.depthTestAgainstTerrain = false
    viewer.scene.globe.baseColor = Color.fromCssColorString('#c7d1cc')
    viewer.scene.backgroundColor = Color.fromCssColorString('#b9c8c1')
    viewer.scene.verticalExaggeration = useWorldTerrain ? 1.25 : 1
    viewer.scene.globe.enableLighting = false
    viewer.scene.fog.enabled = false

    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false
    if (viewer.scene.sun) viewer.scene.sun.show = false
    if (viewer.scene.moon) viewer.scene.moon.show = false

    const controller = viewer.scene.screenSpaceCameraController
    controller.enableCollisionDetection = true
    controller.minimumZoomDistance = 35
    controller.maximumZoomDistance = 100_000
    controller.zoomFactor = 3
    controller.inertiaZoom = 0.72
    controller.inertiaSpin = 0.82
    controller.inertiaTranslate = 0.82
    // 1 doigt / clic gauche : déplacement classique de la carte.
    controller.translateEventTypes = CameraEventType.LEFT_DRAG
    controller.rotateEventTypes = CameraEventType.LEFT_DRAG
    // Zoom : molette ou pincement à deux doigts.
    controller.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH]
    // Vue 3D (haut/bas/côté) : 2 doigts, clic droit, molette cliquée ou Ctrl+glisser.
    controller.tiltEventTypes = [
      CameraEventType.PINCH,
      CameraEventType.RIGHT_DRAG,
      CameraEventType.MIDDLE_DRAG,
      {
        eventType: CameraEventType.LEFT_DRAG,
        modifier: KeyboardEventModifier.CTRL,
      },
    ]
    if (useWorldTerrain) {
      void ArcGISTiledElevationTerrainProvider.fromUrl(arcGisTerrainUrl)
        .then((terrainProvider) => {
          if (!viewer.isDestroyed()) {
            viewer.terrainProvider = terrainProvider
            viewer.scene.requestRender()
          }
        })
        .catch(() => undefined)
    }

    const canvas = viewer.scene.canvas
    let suppressClick = false
    let draggedPoint:
      | { pointerId: number; point: TrailPoint; entity: Entity; position: Cartesian3 | null }
      | null = null

    // Appui long en mode Studio sur la carte vide : créer un point.
    let longPressTimer: number | null = null
    let longPressOrigin: { x: number; y: number } | null = null
    let longPressScreen: Cartesian2 | null = null

    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer)
        longPressTimer = null
      }
      longPressOrigin = null
      longPressScreen = null
    }

    const armLongPress = (event: PointerEvent, screen: Cartesian2) => {
      cancelLongPress()
      longPressOrigin = { x: event.clientX, y: event.clientY }
      longPressScreen = screen
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null
        const screenPosition = longPressScreen
        cancelLongPress()
        if (!screenPosition || viewer.isDestroyed()) return
        const ray = viewer.camera.getPickRay(screenPosition)
        const position = ray
          ? viewer.scene.globe.pick(ray, viewer.scene)
          : undefined
        if (!position) return
        const cartographic = Cartographic.fromCartesian(position)
        suppressClick = true
        onCreatePointRef.current?.(
          CesiumMath.toDegrees(cartographic.latitude),
          CesiumMath.toDegrees(cartographic.longitude),
        )
      }, 550)
    }

    // Glisser-déposer des points en mode Studio : la caméra est gelée
    // pendant le drag pour que la carte ne bouge pas sous le point.
    const handlePointerDown = (event: PointerEvent) => {
      if (!editableRef.current) return
      if (event.pointerType === 'mouse' && event.button !== 0) return

      const rect = canvas.getBoundingClientRect()
      const screenPosition = new Cartesian2(
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
      const picked = viewer.scene.pick(screenPosition)
      // Sur un groupe (cluster) : ni déplacement ni création de point.
      if (Array.isArray(picked?.id)) {
        cancelLongPress()
        return
      }
      const entity = picked?.id as Entity | undefined
      const point = defined(entity?.id)
        ? pointsByEntityId.current.get(entity.id)
        : undefined

      if (point?.id && entity) {
        cancelLongPress()
        // Verrou par défaut : on ne déplace que les points déverrouillés.
        // Sinon on laisse le clic ouvrir la fiche / la photo.
        if (point.locked === false) {
          draggedPoint = {
            pointerId: event.pointerId,
            point,
            entity,
            position: null,
          }
          controller.enableInputs = false
          canvas.setPointerCapture?.(event.pointerId)
          canvas.style.cursor = 'grabbing'
        }
        return
      }

      // Carte vide : on arme l'appui long pour déposer un nouveau point.
      armLongPress(event, screenPosition)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (longPressOrigin) {
        const movement = Math.hypot(
          event.clientX - longPressOrigin.x,
          event.clientY - longPressOrigin.y,
        )
        if (movement > 10) cancelLongPress()
      }

      if (draggedPoint?.pointerId !== event.pointerId) return

      const rect = canvas.getBoundingClientRect()
      const screenPosition = new Cartesian2(
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
      const ray = viewer.camera.getPickRay(screenPosition)
      const position = ray
        ? viewer.scene.globe.pick(ray, viewer.scene)
        : undefined
      if (!position) return

      draggedPoint.position = position
      if (draggedPoint.entity.position instanceof ConstantPositionProperty) {
        draggedPoint.entity.position.setValue(position)
      }
      viewer.scene.requestRender()
    }

    const handlePointerUp = (event: PointerEvent) => {
      cancelLongPress()
      if (draggedPoint?.pointerId !== event.pointerId) return

      const { point, position } = draggedPoint
      draggedPoint = null
      controller.enableInputs = true
      canvas.style.cursor = ''
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
      suppressClick = position !== null
      if (position && point.id) {
        const cartographic = Cartographic.fromCartesian(position)
        onMovePointRef.current?.(
          point.id,
          CesiumMath.toDegrees(cartographic.latitude),
          CesiumMath.toDegrees(cartographic.longitude),
        )
      }
    }

    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('pointercancel', handlePointerUp)

    // Source dédiée aux points, avec regroupement quand ça se chevauche.
    const pointSource = new CustomDataSource('points')
    void viewer.dataSources.add(pointSource)
    pointSource.clustering.enabled = true
    // pixelRange ≥ demi-largeur vignette (84/2=42) pour que deux thumbnails
    // ne se chevauchent visuellement qu'en étant déjà regroupées.
    pointSource.clustering.pixelRange = 50
    pointSource.clustering.minimumClusterSize = 2
    pointSource.clustering.clusterBillboards = true
    pointSource.clustering.clusterLabels = true
    pointSource.clustering.clusterPoints = true
    pointSource.clustering.clusterEvent.addEventListener(
      (clustered, cluster) => {
        // Ancre déterministe : on épingle le groupe sur une vraie photo (id le
        // plus petit) au lieu du centroïde mouvant → ne bouge pas au zoom.
        const anchorEntity = [...clustered].sort((a, b) =>
          String(a.id).localeCompare(String(b.id)),
        )[0]
        const anchorPosition = anchorEntity?.position?.getValue(
          viewer.clock.currentTime,
        )
        const anchorPoint = anchorEntity?.id
          ? pointsByEntityId.current.get(anchorEntity.id as string)
          : undefined
        const media = anchorPoint
          ? resolvePointMedia(anchorPoint, mediaLibraryRef.current)
          : undefined
        const poster = media?.kind === 'video' ? videoPostersRef.current[media.src] : undefined
        const thumbnailSrc = media?.kind === 'image' ? media.src : poster
        const framed = thumbnailSrc ? framedThumbnailsRef.current[thumbnailSrc] : undefined

        // Cesium ne met l'id du groupe que sur le label : on le copie sur le
        // billboard pour que le clic sur la carte (pas juste le badge) ouvre
        // la galerie.
        cluster.billboard.id = clustered
        // Même référence d'altitude que les vignettes individuelles, sinon le
        // groupe flotte à l'altitude 0 et dérive au zoom sur le terrain 3D.
        const clampReference = useWorldTerrain
          ? HeightReference.CLAMP_TO_GROUND
          : HeightReference.NONE
        cluster.billboard.heightReference = clampReference
        cluster.label.heightReference = clampReference

        cluster.billboard.show = true
        cluster.billboard.image = framed ?? clusterStackUri
        cluster.billboard.width = framed ? thumbnailFrameWidth : 56
        cluster.billboard.height = framed ? thumbnailFrameHeight : 52
        cluster.billboard.verticalOrigin = VerticalOrigin.CENTER
        cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY
        if (framed) cluster.billboard.scaleByDistance = thumbnailScaleByDistance
        if (anchorPosition) cluster.billboard.position = anchorPosition

        // Pastille de comptage, collée au coin haut-droit de la carte centrée
        // et mise à l'échelle avec la vignette (reste accrochée à tous zooms).
        cluster.label.show = true
        cluster.label.text = String(clustered.length)
        cluster.label.font = '700 13px Inter, system-ui, sans-serif'
        cluster.label.fillColor = Color.WHITE
        cluster.label.style = LabelStyle.FILL
        cluster.label.showBackground = true
        cluster.label.backgroundColor = Color.fromCssColorString('#0c1512').withAlpha(0.92)
        cluster.label.backgroundPadding = new Cartesian2(7, 5)
        cluster.label.horizontalOrigin = HorizontalOrigin.CENTER
        cluster.label.verticalOrigin = VerticalOrigin.CENTER
        cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY
        if (anchorPosition) cluster.label.position = anchorPosition
        if (framed) {
          // Coin haut-droit de la carte (centrée sur la coordonnée).
          cluster.label.pixelOffset = new Cartesian2(
            framedCardWidth / 2 - 2,
            -(framedCardHeight / 2 - 2),
          )
          cluster.label.scaleByDistance = thumbnailScaleByDistance
          cluster.label.pixelOffsetScaleByDistance = thumbnailScaleByDistance
        } else {
          cluster.label.pixelOffset = new Cartesian2(0, 0)
        }
      },
    )
    pointSourceRef.current = pointSource

    // Source dédiée aux pins POI : pas de clustering, toujours visibles à leur
    // position exacte (ajoutée après la source média pour se dessiner au-dessus).
    const poiSource = new CustomDataSource('poi')
    void viewer.dataSources.add(poiSource)
    poiSourceRef.current = poiSource

    viewer.screenSpaceEventHandler.setInputAction((movement: { position: Cartesian2 }) => {
      if (suppressClick) {
        suppressClick = false
        return
      }
      const picked = viewer.scene.pick(movement.position)
      const pickedId = picked?.id

      // Clic sur un groupe (« 2 ») : on ouvre toujours la galerie pour
      // feuilleter toutes les photos du groupe (flèches / swipe).
      if (Array.isArray(pickedId)) {
        const entities = pickedId as Entity[]
        const groupPoints = entities
          .map((entity) =>
            defined(entity.id)
              ? pointsByEntityId.current.get(entity.id as string)
              : undefined,
          )
          .filter((value): value is TrailPoint => value !== undefined)

        if (groupPoints.length > 0) onOpenGroupRef.current?.(groupPoints)
        return
      }

      const entity = pickedId as Entity | undefined
      if (!defined(entity?.id)) return
      const point = pointsByEntityId.current.get(entity.id)
      if (point) onMarkerClickRef.current(point)
    }, ScreenSpaceEventType.LEFT_CLICK)

    viewerRef.current = viewer

    return () => {
      cancelLongPress()
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('pointercancel', handlePointerUp)
      viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
      viewer.destroy()
      container.replaceChildren()
      viewerRef.current = null
      pointSourceRef.current = null
      poiSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    const layer = createBaseLayer(basemap)
    layer.brightness = basemap === 'satellite' ? 1.08 : 1
    layer.contrast = basemap === 'satellite' ? 1.04 : 1
    viewer.imageryLayers.removeAll()
    viewer.imageryLayers.add(layer)
    viewer.scene.requestRender()
  }, [basemap])

  useEffect(() => {
    const viewer = viewerRef.current
    const pointSource = pointSourceRef.current
    const poiSource = poiSourceRef.current
    if (!viewer || viewer.isDestroyed() || !pointSource || !poiSource) return

    viewer.entities.removeAll()
    pointSource.entities.removeAll()
    poiSource.entities.removeAll()
    pointsByEntityId.current.clear()

    // Une polyligne colorée par trace (jour 1, jour 2, ...).
    traces.forEach((trace, traceIndex) => {
      const renderedTrack = simplifyTrack(trace.points, 1.5, 6_000)
      const routePositions = renderedTrack.map((point) =>
        Cartesian3.fromDegrees(point.lng, point.lat, 0),
      )
      if (routePositions.length < 2) return

      viewer.entities.add({
        id: `trail-route-outline-${trace.id}`,
        polyline: {
          positions: routePositions,
          width: 10,
          clampToGround: true,
          material: routeOuterColor,
          zIndex: 20,
        },
      })
      viewer.entities.add({
        id: `trail-route-${trace.id}`,
        polyline: {
          positions: routePositions,
          width: 5,
          clampToGround: true,
          material: Color.fromCssColorString(
            trace.color ?? traceColor(traceIndex),
          ),
          zIndex: 21,
        },
      })
    })

    const heightReference = useWorldTerrain
      ? HeightReference.CLAMP_TO_GROUND
      : HeightReference.NONE

    // Vignettes média → source clusterisée (se regroupent entre elles).
    // Pins POI → source non clusterisée, toujours visibles à leur position.
    points.forEach((point, index) => {
      const id = pointEntityId(point, index)
      pointsByEntityId.current.set(id, point)
      const media = resolvePointMedia(point, mediaLibrary)
      const poster =
        media?.kind === 'video' ? videoPosters[media.src] : undefined
      const thumbnailSrc = media?.kind === 'image' ? media.src : poster
      // On n'affiche la carte média que lorsque sa version encadrée est prête,
      // sinon on garde le pin (évite une vignette brute sans cadre/ancrage).
      const framed = thumbnailSrc ? framedThumbnails[thumbnailSrc] : undefined
      const showThumbnail = Boolean(framed)
      const position = Cartesian3.fromDegrees(point.lng, point.lat, 0)

      const target = showThumbnail ? pointSource : poiSource
      target.entities.add({
        id,
        name: point.title,
        position,
        billboard: {
          image: showThumbnail
            ? (framed as string)
            : point.color
              ? coloredMarkerDataUri(point.color)
              : markerDataUri(point.type),
          width: showThumbnail ? thumbnailFrameWidth : 42,
          height: showThumbnail ? thumbnailFrameHeight : 50,
          // Vignette centrée sur la coordonnée (reste plantée au zoom) ;
          // pin ancré par sa pointe.
          verticalOrigin: showThumbnail
            ? VerticalOrigin.CENTER
            : VerticalOrigin.BOTTOM,
          heightReference,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: thumbnailScaleByDistance,
        },
      })
    })

    viewer.scene.requestRender()
    if (!didInitialFitRef.current) {
      didInitialFitRef.current = true
      flyToTrail(viewer, track, points, 0)
    }
  }, [mediaLibrary, points, track, traces, videoPosters, framedThumbnails])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || recenterRequest === 0) return
    flyToTrail(viewer, track, points, 0)
  }, [points, recenterRequest, track])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !cameraCommand) return

    const height = Math.max(viewer.camera.positionCartographic.height, 100)
    if (cameraCommand.type === 'turn-left') {
      viewer.camera.lookLeft(CesiumMath.toRadians(14))
    } else if (cameraCommand.type === 'turn-right') {
      viewer.camera.lookRight(CesiumMath.toRadians(14))
    } else if (cameraCommand.type === 'zoom-in') {
      viewer.camera.zoomIn(height * 0.16)
    } else if (cameraCommand.type === 'zoom-out') {
      viewer.camera.zoomOut(height * 0.16)
    } else {
      const delta = cameraCommand.type === 'tilt-up' ? 8 : -8
      viewer.camera.setView({
        orientation: {
          heading: viewer.camera.heading,
          pitch: CesiumMath.clamp(
            viewer.camera.pitch + CesiumMath.toRadians(delta),
            CesiumMath.toRadians(-88),
            CesiumMath.toRadians(-6),
          ),
          roll: 0,
        },
      })
    }
    viewer.scene.requestRender()
  }, [cameraCommand])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!selectedPoint || !viewer) return
    const key = selectedPoint.id ?? selectedPoint.title
    if (selectedKeyRef.current === key) return
    selectedKeyRef.current = key

    const target = new BoundingSphere(
      Cartesian3.fromDegrees(selectedPoint.lng, selectedPoint.lat, 0),
      35,
    )
    viewer.camera.flyToBoundingSphere(target, {
      duration: 1.1,
      offset: new HeadingPitchRange(
        viewer.camera.heading,
        CesiumMath.toRadians(-45),
        2_800,
      ),
    })
    viewer.scene.requestRender()
  }, [selectedPoint])

  return (
    <div className="trail-map">
      <div ref={containerRef} className="trail-map-canvas" />
    </div>
  )
}
