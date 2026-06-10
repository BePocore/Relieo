import { useEffect, useRef } from 'react'
import CesiumNavigation from 'cesium-navigation-es6'
import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  BoundingSphere,
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Color,
  CornerType,
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
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
  defined,
  type Entity,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { ImportedMedia, TrailPoint, TrackPoint } from '../types'
import { nearestElevation } from '../lib/geo'
import { markerDataUri } from '../lib/markers'
import { resolvePointMedia } from '../lib/media'
import { cesiumIonToken, useWorldTerrain } from '../lib/terrain'
import type { BasemapId } from '../lib/basemaps'

if (cesiumIonToken) {
  Ion.defaultAccessToken = cesiumIonToken
}

type TrailMapProps = {
  track: TrackPoint[]
  points: TrailPoint[]
  mediaLibrary: ImportedMedia[]
  basemap: BasemapId
  recenterRequest: number
  selectedPoint: TrailPoint | null
  onSelectPoint: (point: TrailPoint) => void
}

type CesiumNavigationInstance = {
  destroy: () => void
}

const routeOutlineColor = Color.fromCssColorString('#ffffff').withAlpha(0.78)
const routeColor = Color.fromCssColorString('#145c52')
const arcGisTerrainUrl =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

const computeBounds = (track: TrackPoint[], points: TrailPoint[]): Rectangle => {
  const coordinates = [
    ...track.map((point) => ({ lat: point.lat, lng: point.lng })),
    ...points.map((point) => ({ lat: point.lat, lng: point.lng })),
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
  const latPadding = Math.max((maxLat - minLat) * 0.2, 0.01)
  const lngPadding = Math.max((maxLng - minLng) * 0.2, 0.01)

  return Rectangle.fromDegrees(
    minLng - lngPadding,
    minLat - latPadding,
    maxLng + lngPadding,
    maxLat + latPadding,
  )
}

const pointEntityId = (point: TrailPoint, index: number): string => {
  return `trail-point-${point.id ?? index}`
}

const cameraPositionsForTrail = (
  track: TrackPoint[],
  points: TrailPoint[],
): Cartesian3[] => {
  return track.length > 0
    ? track.map((point) => Cartesian3.fromDegrees(point.lng, point.lat, 0))
    : points.map((point) => Cartesian3.fromDegrees(point.lng, point.lat, 0))
}

const flyToTrail = (
  viewer: Viewer,
  track: TrackPoint[],
  points: TrailPoint[],
  duration: number,
) => {
  const cameraPositions = cameraPositionsForTrail(track, points)

  if (cameraPositions.length > 0) {
    const boundingSphere = BoundingSphere.fromPoints(cameraPositions)
    viewer.camera.flyToBoundingSphere(boundingSphere, {
      duration,
      offset: new HeadingPitchRange(
        CesiumMath.toRadians(28),
        CesiumMath.toRadians(-60),
        Math.max(boundingSphere.radius * 5.2, 3_200),
      ),
    })
    return
  }

  viewer.camera.flyTo({
    destination: computeBounds(track, points),
    duration,
  })
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
  onSelectPoint,
}: TrailMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const viewerRef = useRef<Viewer | null>(null)
  const pointsByEntityId = useRef(new Map<string, TrailPoint>())

  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    container.replaceChildren()

    const viewer = new Viewer(container, {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      shouldAnimate: true,
    })

    if (useWorldTerrain) {
      void ArcGISTiledElevationTerrainProvider.fromUrl(arcGisTerrainUrl)
        .then((terrainProvider) => {
          if (!viewer.isDestroyed()) {
            viewer.terrainProvider = terrainProvider
          }
        })
        .catch(() => {
          if (!viewer.isDestroyed()) {
            viewer.terrainProvider = new EllipsoidTerrainProvider()
          }
        })
    }

    const baseLayer = createBaseLayer(basemap)
    baseLayer.brightness = basemap === 'satellite' ? 1.25 : 1
    viewer.imageryLayers.removeAll()
    viewer.imageryLayers.add(baseLayer)

    viewer.scene.backgroundColor = Color.fromCssColorString('#d8e1dd')
    viewer.scene.globe.depthTestAgainstTerrain = false
    viewer.scene.globe.baseColor = Color.fromCssColorString('#d8cbbb')
    viewer.scene.globe.enableLighting = false
    viewer.scene.verticalExaggeration = useWorldTerrain ? 1.8 : 1
    viewer.scene.verticalExaggerationRelativeHeight = 0
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = false
    }
    if (viewer.scene.skyBox) {
      viewer.scene.skyBox.show = false
    }
    if (viewer.scene.sun) {
      viewer.scene.sun.show = false
    }
    if (viewer.scene.moon) {
      viewer.scene.moon.show = false
    }
    const cameraController = viewer.scene.screenSpaceCameraController
    const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches
    cameraController.enableCollisionDetection = true
    cameraController.minimumZoomDistance = 60
    cameraController.maximumZoomDistance = 60_000
    cameraController.zoomFactor = hasCoarsePointer ? 1.22 : 1.15
    cameraController.inertiaZoom = hasCoarsePointer ? 0.34 : 0.6
    cameraController.inertiaSpin = hasCoarsePointer ? 0.62 : 0.8
    cameraController.maximumMovementRatio = hasCoarsePointer ? 0.055 : 0.08
    cameraController.zoomEventTypes = [
      CameraEventType.WHEEL,
      CameraEventType.PINCH,
    ]
    cameraController.rotateEventTypes = CameraEventType.LEFT_DRAG
    cameraController.tiltEventTypes = [
      CameraEventType.RIGHT_DRAG,
      CameraEventType.MIDDLE_DRAG,
    ]
    const navigationOptions = {
      defaultResetView: computeBounds(track, points),
      duration: 0.75,
      enableCompass: true,
      enableCompassOuterRing: true,
      enableDistanceLegend: false,
      enableZoomControls: false,
      orientation: {
        heading: CesiumMath.toRadians(28),
        pitch: CesiumMath.toRadians(-60),
        roll: 0,
      },
      resetTooltip: 'Recentrer la vue',
      zoomInTooltip: 'Zoomer',
      zoomOutTooltip: 'Dezoomer',
    }
    const navigation = new CesiumNavigation(
      viewer,
      navigationOptions,
    ) as unknown as CesiumNavigationInstance
    const compass = container.querySelector('.compass')
    compass?.setAttribute('aria-label', 'Boussole de navigation 3D')
    compass?.setAttribute('role', 'application')
    compass?.setAttribute(
      'title',
      "Tourner avec l'anneau, incliner avec le centre",
    )
    viewerRef.current = viewer
    pointsByEntityId.current.clear()

    const routePositions = track.map((point) =>
      Cartesian3.fromDegrees(point.lng, point.lat, 0),
    )

    if (routePositions.length > 1) {
      viewer.entities.add({
        id: 'trail-route',
        name: 'Parcours GPX',
        corridor: {
          positions: routePositions,
          width: 15,
          cornerType: CornerType.ROUNDED,
          material: routeOutlineColor,
          zIndex: 20,
        },
      })

      viewer.entities.add({
        id: 'trail-route-core',
        name: 'Trace',
        corridor: {
          positions: routePositions,
          width: 11,
          cornerType: CornerType.ROUNDED,
          material: routeColor,
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
        position: Cartesian3.fromDegrees(
          point.lng,
          point.lat,
          0,
        ),
        billboard: {
          image: showThumbnail ? media.src : markerDataUri(point.type),
          width: showThumbnail ? 64 : 38,
          height: showThumbnail ? 48 : 46,
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: useWorldTerrain
            ? HeightReference.CLAMP_TO_GROUND
            : HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(1_000, 1, 250_000, 0.58),
        },
        label: {
          text: point.title,
          font: '600 13px Segoe UI, system-ui, sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.fromCssColorString('#0f172a'),
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: Color.fromCssColorString('rgba(15, 23, 42, 0.72)'),
          backgroundPadding: new Cartesian2(8, 5),
          pixelOffset: new Cartesian2(0, showThumbnail ? -74 : -52),
          verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: useWorldTerrain
            ? HeightReference.CLAMP_TO_GROUND
            : HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new NearFarScalar(1_000, 1, 220_000, 0.45),
        },
      })
    })

    const clickHandler = new ScreenSpaceEventHandler(viewer.scene.canvas)
    clickHandler.setInputAction(
      (movement: { position: Cartesian2 }) => {
        const picked = viewer.scene.pick(movement.position)
        const entity = picked?.id as Entity | undefined

        if (!defined(entity?.id)) return

        const point = pointsByEntityId.current.get(entity.id)
        if (point) onSelectPoint(point)
      },
      ScreenSpaceEventType.LEFT_CLICK,
    )

    flyToTrail(viewer, track, points, 0.9)

    return () => {
      clickHandler.destroy()
      navigation.destroy()
      viewer.destroy()
      container.replaceChildren()
      viewerRef.current = null
    }
  }, [track, points, mediaLibrary, basemap, onSelectPoint])

  useEffect(() => {
    if (!viewerRef.current || recenterRequest === 0) return

    flyToTrail(viewerRef.current, track, points, 0.65)
  }, [recenterRequest, track, points])

  useEffect(() => {
    if (!selectedPoint || !viewerRef.current) return

    const altitude =
      useWorldTerrain
        ? 0
        : selectedPoint.altitude ?? nearestElevation(selectedPoint, track) ?? 0

    const target = new BoundingSphere(
      Cartesian3.fromDegrees(selectedPoint.lng, selectedPoint.lat, altitude),
      40,
    )

    viewerRef.current.camera.flyToBoundingSphere(target, {
      duration: 0.65,
      offset: new HeadingPitchRange(
        CesiumMath.toRadians(28),
        CesiumMath.toRadians(-50),
        1_150,
      ),
    })
  }, [selectedPoint, track])

  return (
    <div className="trail-map">
      <div ref={containerRef} className="trail-map-canvas" />
    </div>
  )
}
