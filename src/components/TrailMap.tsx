import { useEffect, useRef } from 'react'
import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ConstantPositionProperty,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  HeightReference,
  ImageryLayer,
  Ion,
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
import type { ImportedMedia, TrailPoint, TrackPoint } from '../types'
import { simplifyTrack } from '../lib/geo'
import { markerDataUri } from '../lib/markers'
import { resolvePointMedia } from '../lib/media'
import { cesiumIonToken, useWorldTerrain } from '../lib/terrain'
import type { BasemapId } from '../lib/basemaps'

if (cesiumIonToken) Ion.defaultAccessToken = cesiumIonToken

type TrailMapProps = {
  track: TrackPoint[]
  points: TrailPoint[]
  mediaLibrary: ImportedMedia[]
  basemap: BasemapId
  recenterRequest: number
  selectedPoint: TrailPoint | null
  cameraCommand: CameraCommand | null
  editable?: boolean
  isTourActive?: boolean
  onTourStop?: () => void
  onMovePoint?: (pointId: string, lat: number, lng: number) => void
  onSelectPoint: (point: TrailPoint) => void
}

export type CameraCommand = {
  id: number
  type: 'turn-left' | 'turn-right' | 'zoom-in' | 'zoom-out'
}

const routeOuterColor = Color.fromCssColorString('#ffffff')
const routeInnerColor = Color.fromCssColorString('#f4512c')
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
  track,
  points,
  mediaLibrary,
  basemap,
  recenterRequest,
  selectedPoint,
  cameraCommand,
  editable = false,
  isTourActive = false,
  onTourStop,
  onMovePoint,
  onSelectPoint,
}: TrailMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointsByEntityId = useRef(new Map<string, TrailPoint>())
  const onSelectPointRef = useRef(onSelectPoint)
  const onMovePointRef = useRef(onMovePoint)
  const onTourStopRef = useRef(onTourStop)
  const editableRef = useRef(editable)
  const selectedKeyRef = useRef<string | null>(null)
  const didInitialFitRef = useRef(false)

  useEffect(() => {
    onSelectPointRef.current = onSelectPoint
    onMovePointRef.current = onMovePoint
    onTourStopRef.current = onTourStop
    editableRef.current = editable
  }, [editable, onMovePoint, onSelectPoint, onTourStop])

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
    controller.enableInputs = false
    controller.enableCollisionDetection = true
    controller.minimumZoomDistance = 35
    controller.maximumZoomDistance = 100_000
    controller.zoomFactor = 1.5
    controller.inertiaZoom = 0.72
    controller.inertiaSpin = 0.82
    controller.inertiaTranslate = 0.76
    controller.maximumMovementRatio = 0.08
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
    const pointers = new Map<number, { x: number; y: number }>()
    let previousPinchDistance: number | null = null
    let previousPinchCenter: { x: number; y: number } | null = null
    let suppressClick = false
    let draggedPoint:
      | { pointerId: number; point: TrailPoint; entity: Entity; position: Cartesian3 | null }
      | null = null

    const pointerValues = () => Array.from(pointers.values())
    const pointerDistance = (values: { x: number; y: number }[]) =>
      Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y)
    const pointerCenter = (values: { x: number; y: number }[]) => ({
      x: (values[0].x + values[1].x) / 2,
      y: (values[0].y + values[1].y) / 2,
    })

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      if (editableRef.current) {
        const rect = canvas.getBoundingClientRect()
        const screenPosition = new Cartesian2(
          event.clientX - rect.left,
          event.clientY - rect.top,
        )
        const picked = viewer.scene.pick(screenPosition)
        const entity = picked?.id as Entity | undefined
        const point = defined(entity?.id)
          ? pointsByEntityId.current.get(entity.id)
          : undefined

        if (point?.id && entity) {
          draggedPoint = {
            pointerId: event.pointerId,
            point,
            entity,
            position: null,
          }
          suppressClick = true
          canvas.setPointerCapture?.(event.pointerId)
          canvas.style.cursor = 'grabbing'
          return
        }
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      canvas.setPointerCapture?.(event.pointerId)
      if (pointers.size === 2) {
        const values = pointerValues()
        previousPinchDistance = pointerDistance(values)
        previousPinchCenter = pointerCenter(values)
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (draggedPoint?.pointerId === event.pointerId) {
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
        return
      }

      const previous = pointers.get(event.pointerId)
      if (!previous) return

      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const values = pointerValues()
      const dx = event.clientX - previous.x
      const dy = event.clientY - previous.y

      if (values.length === 1) {
        if (Math.abs(dx) + Math.abs(dy) < 0.5) return
        suppressClick = true
        viewer.camera.setView({
          orientation: {
            heading: viewer.camera.heading - dx * 0.004,
            pitch: CesiumMath.clamp(
              viewer.camera.pitch + dy * 0.003,
              CesiumMath.toRadians(-86),
              CesiumMath.toRadians(-8),
            ),
            roll: 0,
          },
        })
      } else if (values.length >= 2) {
        suppressClick = true
        const distance = pointerDistance(values)
        const center = pointerCenter(values)
        const height = Math.max(viewer.camera.positionCartographic.height, 100)

        if (previousPinchDistance !== null) {
          const zoomAmount = (distance - previousPinchDistance) * height * 0.0024
          if (zoomAmount > 0) viewer.camera.zoomIn(zoomAmount)
          else viewer.camera.zoomOut(Math.abs(zoomAmount))
        }
        if (previousPinchCenter) {
          const panFactor = height * 0.00045
          viewer.camera.moveLeft((center.x - previousPinchCenter.x) * panFactor)
          viewer.camera.moveUp((previousPinchCenter.y - center.y) * panFactor)
        }
        previousPinchDistance = distance
        previousPinchCenter = center
      }
      viewer.scene.requestRender()
    }

    const handlePointerUp = (event: PointerEvent) => {
      if (draggedPoint?.pointerId === event.pointerId) {
        const { point, position } = draggedPoint
        draggedPoint = null
        canvas.style.cursor = ''
        if (position && point.id) {
          const cartographic = Cartographic.fromCartesian(position)
          onMovePointRef.current?.(
            point.id,
            CesiumMath.toDegrees(cartographic.latitude),
            CesiumMath.toDegrees(cartographic.longitude),
          )
        }
      }
      pointers.delete(event.pointerId)
      if (canvas.hasPointerCapture?.(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
      if (pointers.size < 2) {
        previousPinchDistance = null
        previousPinchCenter = null
      }
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const height = Math.max(viewer.camera.positionCartographic.height, 100)
      const amount = Math.min(Math.abs(event.deltaY) * height * 0.00045, height * 0.16)
      if (event.deltaY < 0) viewer.camera.zoomIn(amount)
      else viewer.camera.zoomOut(amount)
      viewer.scene.requestRender()
    }

    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('pointercancel', handlePointerUp)
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    viewer.screenSpaceEventHandler.setInputAction((movement: { position: Cartesian2 }) => {
      if (suppressClick) {
        suppressClick = false
        return
      }
      const picked = viewer.scene.pick(movement.position)
      const entity = picked?.id as Entity | undefined
      if (!defined(entity?.id)) return
      const point = pointsByEntityId.current.get(entity.id)
      if (point) onSelectPointRef.current(point)
    }, ScreenSpaceEventType.LEFT_CLICK)

    viewerRef.current = viewer

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('pointercancel', handlePointerUp)
      canvas.removeEventListener('wheel', handleWheel)
      viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK)
      viewer.destroy()
      container.replaceChildren()
      viewerRef.current = null
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
    if (!viewer || viewer.isDestroyed()) return

    viewer.entities.removeAll()
    pointsByEntityId.current.clear()

    const renderedTrack = simplifyTrack(track, 1.5, 6_000)
    const routePositions = renderedTrack.map((point) =>
      Cartesian3.fromDegrees(point.lng, point.lat, 0),
    )

    if (routePositions.length > 1) {
      viewer.entities.add({
        id: 'trail-route-outline',
        polyline: {
          positions: routePositions,
          width: 10,
          clampToGround: true,
          material: routeOuterColor,
          zIndex: 20,
        },
      })
      viewer.entities.add({
        id: 'trail-route',
        polyline: {
          positions: routePositions,
          width: 5,
          clampToGround: true,
          material: routeInnerColor,
          zIndex: 21,
        },
      })
    }

    points.forEach((point, index) => {
      const id = pointEntityId(point, index)
      pointsByEntityId.current.set(id, point)
      const media = resolvePointMedia(point, mediaLibrary)
      const showThumbnail = media?.kind === 'image'

      viewer.entities.add({
        id,
        name: point.title,
        position: Cartesian3.fromDegrees(point.lng, point.lat, 0),
        billboard: {
          image: showThumbnail ? media.src : markerDataUri(point.type),
          width: showThumbnail ? 76 : 42,
          height: showThumbnail ? 56 : 50,
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: useWorldTerrain
            ? HeightReference.CLAMP_TO_GROUND
            : HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(1_000, 1, 160_000, 0.6),
        },
        label: {
          text: point.title,
          font: '700 13px Inter, system-ui, sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString('#111827'),
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(17, 24, 39, 0.82)'),
          backgroundPadding: new Cartesian2(8, 5),
          pixelOffset: new Cartesian2(0, showThumbnail ? -80 : -57),
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: useWorldTerrain
            ? HeightReference.CLAMP_TO_GROUND
            : HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(1_000, 1, 150_000, 0.52),
        },
      })
    })

    viewer.scene.requestRender()
    if (!didInitialFitRef.current) {
      didInitialFitRef.current = true
      flyToTrail(viewer, track, points, 0)
    }
  }, [mediaLibrary, points, track])

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
    } else {
      viewer.camera.zoomOut(height * 0.16)
    }
    viewer.scene.requestRender()
  }, [cameraCommand])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed() || !isTourActive) return

    const interval = window.setInterval(() => {
      if (viewer.isDestroyed()) return
      viewer.camera.lookRight(0.003)
      viewer.scene.requestRender()
    }, 50)

    const canvas = viewer.scene.canvas
    const stopTour = () => onTourStopRef.current?.()
    canvas.addEventListener('pointerdown', stopTour)

    return () => {
      window.clearInterval(interval)
      canvas.removeEventListener('pointerdown', stopTour)
    }
  }, [isTourActive])

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
      duration: 0,
      offset: new HeadingPitchRange(
        viewer.camera.heading,
        CesiumMath.toRadians(-45),
        900,
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
