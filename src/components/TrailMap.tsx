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
  ConstantProperty,
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
import { coloredMarkerDataUri, traceColor } from '../lib/mapStyles'
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
  // Mode 2D allégé (terrain plat + vue du dessus) pour les appareils faibles.
  flat2D?: boolean
  videoPosters?: Record<string, string>
  framedThumbnails?: Record<string, string>
  onMovePoint?: (pointId: string, lat: number, lng: number) => void
  onCreatePoint?: (lat: number, lng: number) => void
  onMarkerClick: (point: TrailPoint) => void
  onOpenGroup?: (points: TrailPoint[]) => void
  // Appelé une fois que le globe a fini de charger ses tuiles (carte prête).
  onReady?: () => void
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
const combineTracePoints = (traces: Trace[]): TrackPoint[] =>
  traces.flatMap((trace) => trace.points)

// Billboard dimensionné sur le canvas de la vignette encadrée (carte + ancrage).
const thumbnailFrameWidth = framedCanvasWidth
const thumbnailFrameHeight = framedCanvasHeight
// Échelle plus stable selon le zoom (1 → 0.85) pour des vignettes homogènes.
const thumbnailScaleByDistance = new NearFarScalar(1_000, 1, 160_000, 0.85)
// Constantes du badge de comptage des clusters, hissées hors du clusterEvent
// (qui se déclenche à chaque zoom/pan) pour éviter de réallouer à chaque fois.
const clusterBadgeFont = '700 13px Inter, system-ui, sans-serif'
const clusterBadgeColor = Color.fromCssColorString('#0c1512').withAlpha(0.92)
const clusterBadgePadding = new Cartesian2(7, 5)
const clusterLabelOffset = new Cartesian2(
  framedCardWidth / 2 - 2,
  -(framedCardHeight / 2 - 2),
)
const clusterLabelOffsetZero = new Cartesian2(0, 0)
const arcGisTerrainUrl =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

// Vue 3D (inclinaison) : 2 doigts, clic droit, molette cliquée ou Ctrl+glisser.
// Vidé en mode 2D (vue du dessus verrouillée).
const tilt3DEventTypes = [
  CameraEventType.PINCH,
  CameraEventType.RIGHT_DRAG,
  CameraEventType.MIDDLE_DRAG,
  {
    eventType: CameraEventType.LEFT_DRAG,
    modifier: KeyboardEventModifier.CTRL,
  },
]

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

// État d'affichage d'un point : a-t-il un média (→ source clusterisée) et sa
// vignette encadrée est-elle déjà prête ? Centralisé pour que l'effet structurel
// et l'effet de rafraîchissement d'image partagent exactement la même logique.
const thumbForPoint = (
  point: TrailPoint,
  mediaLibrary: ImportedMedia[],
  videoPosters: Record<string, string>,
  framedThumbnails: Record<string, string>,
): { hasMedia: boolean; framed: string | undefined } => {
  const media = resolvePointMedia(point, mediaLibrary)
  if (!media) return { hasMedia: false, framed: undefined }
  const thumbnailSrc =
    media.kind === 'image'
      ? (media.thumbnailSrc ?? media.src)
      : media.kind === 'video'
        ? videoPosters[media.src]
        : undefined
  const framed = thumbnailSrc ? framedThumbnails[thumbnailSrc] : undefined
  return { hasMedia: true, framed }
}

const flyToTrail = (
  viewer: Viewer,
  track: TrackPoint[],
  points: TrailPoint[],
  duration: number,
  flat2D = false,
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
      // 2D : vue du dessus, sans rotation ni inclinaison.
      CesiumMath.toRadians(flat2D ? 0 : 24),
      CesiumMath.toRadians(flat2D ? -90 : -52),
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
  flat2D = false,
  videoPosters = {},
  framedThumbnails = {},
  onMovePoint,
  onCreatePoint,
  onMarkerClick,
  onOpenGroup,
  onReady,
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
  const onReadyRef = useRef(onReady)
  const editableRef = useRef(editable)
  const selectedKeyRef = useRef<string | null>(null)
  const didInitialFitRef = useRef(false)
  const readyFiredRef = useRef(false)
  const mediaLibraryRef = useRef(mediaLibrary)
  const videoPostersRef = useRef(videoPosters)
  const framedThumbnailsRef = useRef(framedThumbnails)
  // Mode 2D + données courantes lues par les callbacks/effets sans les ajouter
  // en dépendances (évite de relancer le lourd effet d'init).
  const flat2DRef = useRef(flat2D)
  const pointsRef = useRef(points)
  const trackRef = useRef(track)
  // L'init applique déjà l'état 2D initial ; l'effet de bascule ignore son 1er run.
  const flat2DFirstRunRef = useRef(true)
  // Vignette encadrée déjà appliquée à l'entité (id → src), pour ne mettre à
  // jour que les billboards dont la vignette vient d'arriver (rafraîchissement
  // incrémental, sans reconstruire la carte).
  const thumbAppliedRef = useRef(new Map<string, string>())

  useEffect(() => {
    onMarkerClickRef.current = onMarkerClick
    onMovePointRef.current = onMovePoint
    onCreatePointRef.current = onCreatePoint
    onOpenGroupRef.current = onOpenGroup
    onReadyRef.current = onReady
    editableRef.current = editable
    mediaLibraryRef.current = mediaLibrary
    videoPostersRef.current = videoPosters
    framedThumbnailsRef.current = framedThumbnails
    flat2DRef.current = flat2D
    pointsRef.current = points
    trackRef.current = track
  }, [editable, onMovePoint, onCreatePoint, onMarkerClick, onOpenGroup, onReady, mediaLibrary, videoPosters, framedThumbnails, flat2D, points, track])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.replaceChildren()
    didInitialFitRef.current = false
    const coarsePointer =
      window.matchMedia('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0
    // État initial du mode 2D (les bascules ultérieures passent par l'effet
    // dédié plus bas). msaa/antialias ne sont réglables qu'à la création.
    const flat2D0 = flat2DRef.current
    const terrain3D0 = useWorldTerrain && !flat2D0
    const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1)
    const targetPixelRatio = Math.min(
      devicePixelRatio,
      flat2D0 ? 1.5 : coarsePointer ? 2 : 2.25,
    )

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
      msaaSamples: flat2D0 ? 1 : coarsePointer ? 2 : 4,
      useBrowserRecommendedResolution: false,
      contextOptions: {
        webgl: {
          antialias: !flat2D0,
          powerPreference: 'high-performance',
        },
      },
    })

    viewer.resolutionScale = targetPixelRatio / devicePixelRatio
    container.dataset.renderDpr = targetPixelRatio.toFixed(2)
    viewer.scene.postProcessStages.fxaa.enabled = true
    viewer.scene.globe.maximumScreenSpaceError = flat2D0 ? 3 : coarsePointer ? 2 : 1.5
    viewer.scene.globe.tileCacheSize = flat2D0 ? 100 : coarsePointer ? 260 : 420
    viewer.scene.globe.preloadAncestors = true
    viewer.scene.globe.preloadSiblings = true
    viewer.scene.globe.depthTestAgainstTerrain = false
    viewer.scene.globe.baseColor = Color.fromCssColorString('#c7d1cc')
    viewer.scene.backgroundColor = Color.fromCssColorString('#b9c8c1')
    viewer.scene.verticalExaggeration = terrain3D0 ? 1.25 : 1
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
    // Inclinaison désactivée en 2D (vue du dessus verrouillée).
    controller.tiltEventTypes = flat2D0 ? [] : tilt3DEventTypes
    if (terrain3D0) {
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
        const thumbnailSrc =
          media?.kind === 'image' ? (media.thumbnailSrc ?? media.src) : poster
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
        cluster.label.font = clusterBadgeFont
        cluster.label.fillColor = Color.WHITE
        cluster.label.style = LabelStyle.FILL
        cluster.label.showBackground = true
        cluster.label.backgroundColor = clusterBadgeColor
        cluster.label.backgroundPadding = clusterBadgePadding
        cluster.label.horizontalOrigin = HorizontalOrigin.CENTER
        cluster.label.verticalOrigin = VerticalOrigin.CENTER
        cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY
        if (anchorPosition) cluster.label.position = anchorPosition
        if (framed) {
          // Coin haut-droit de la carte (centrée sur la coordonnée).
          cluster.label.pixelOffset = clusterLabelOffset
          cluster.label.scaleByDistance = thumbnailScaleByDistance
          cluster.label.pixelOffsetScaleByDistance = thumbnailScaleByDistance
        } else {
          cluster.label.pixelOffset = clusterLabelOffsetZero
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

    // Signale « carte prête » quand le globe a fini de charger ses tuiles.
    // tileLoadProgressEvent donne le nombre de tuiles restant à charger : on
    // attend que le chargement ait démarré (>0) puis se vide (0). Filet de
    // sécurité : on débloque de toute façon après 12 s.
    const globe = viewer.scene.globe
    let loadingStarted = false
    const fireReady = () => {
      if (readyFiredRef.current) return
      readyFiredRef.current = true
      globe.tileLoadProgressEvent.removeEventListener(handleTileProgress)
      window.clearTimeout(readyFallback)
      onReadyRef.current?.()
    }
    const handleTileProgress = (queued: number) => {
      if (queued > 0) loadingStarted = true
      else if (loadingStarted) fireReady()
    }
    globe.tileLoadProgressEvent.addEventListener(handleTileProgress)
    const readyFallback = window.setTimeout(fireReady, 12_000)

    return () => {
      window.clearTimeout(readyFallback)
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

  // Bascule 2D ⇄ 3D au runtime (toggle manuel ou downgrade auto). Mute le viewer
  // existant sans le détruire : terrain plat vs relief, exagération, inclinaison,
  // allègement du rendu, et recadrage vue du dessus. Le 1er run est ignoré (l'init
  // a déjà posé l'état initial).
  useEffect(() => {
    if (flat2DFirstRunRef.current) {
      flat2DFirstRunRef.current = false
      return
    }
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return
    const scene = viewer.scene
    const controller = scene.screenSpaceCameraController
    const terrain3D = useWorldTerrain && !flat2D
    const coarsePointer =
      window.matchMedia('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0

    if (terrain3D) {
      void ArcGISTiledElevationTerrainProvider.fromUrl(arcGisTerrainUrl)
        .then((terrainProvider) => {
          if (!viewer.isDestroyed()) {
            viewer.terrainProvider = terrainProvider
            scene.requestRender()
          }
        })
        .catch(() => undefined)
    } else {
      viewer.terrainProvider = new EllipsoidTerrainProvider()
    }

    scene.verticalExaggeration = terrain3D ? 1.25 : 1
    controller.tiltEventTypes = flat2D ? [] : tilt3DEventTypes

    const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1)
    const cap = flat2D ? 1.5 : coarsePointer ? 2 : 2.25
    viewer.resolutionScale = Math.min(devicePixelRatio, cap) / devicePixelRatio
    scene.globe.maximumScreenSpaceError = flat2D ? 3 : coarsePointer ? 2 : 1.5
    scene.globe.tileCacheSize = flat2D ? 100 : coarsePointer ? 260 : 420

    // Recadre sur la trace avec la nouvelle vue (du dessus en 2D, inclinée en 3D).
    flyToTrail(viewer, trackRef.current, pointsRef.current, 0.8, flat2D)
    scene.requestRender()
  }, [flat2D])

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

  // Effet A — tracés (polylignes). Ne se rejoue que si les traces changent,
  // donc plus à chaque vignette générée.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    // Seules les polylignes vivent dans viewer.entities (les marqueurs sont dans
    // les CustomDataSource), donc removeAll ne touche que les tracés.
    viewer.entities.removeAll()
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
    viewer.scene.requestRender()
  }, [traces])

  // Effet B — structure des points : chaque entité est créée une seule fois.
  // Routage par TYPE de média (et non par disponibilité de la vignette) :
  //   média → source clusterisée ; POI sans média → source non clusterisée.
  // Ne dépend PAS de videoPosters/framedThumbnails (gérés par l'effet C), donc
  // ne reconstruit plus toute la carte à chaque vignette générée.
  useEffect(() => {
    const viewer = viewerRef.current
    const pointSource = pointSourceRef.current
    const poiSource = poiSourceRef.current
    if (!viewer || viewer.isDestroyed() || !pointSource || !poiSource) return

    pointSource.entities.removeAll()
    poiSource.entities.removeAll()
    pointsByEntityId.current.clear()
    thumbAppliedRef.current.clear()

    const heightReference = useWorldTerrain
      ? HeightReference.CLAMP_TO_GROUND
      : HeightReference.NONE

    points.forEach((point, index) => {
      const id = pointEntityId(point, index)
      pointsByEntityId.current.set(id, point)
      const { hasMedia, framed } = thumbForPoint(
        point,
        mediaLibraryRef.current,
        videoPostersRef.current,
        framedThumbnailsRef.current,
      )
      const showThumbnail = Boolean(framed)
      if (showThumbnail) thumbAppliedRef.current.set(id, framed as string)

      const target = hasMedia ? pointSource : poiSource
      target.entities.add({
        id,
        name: point.title,
        position: Cartesian3.fromDegrees(point.lng, point.lat, 0),
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
      flyToTrail(viewer, track, points, 0, flat2DRef.current)
    }
  }, [mediaLibrary, points, track])

  // Effet C — rafraîchissement d'image : quand une vignette encadrée (ou un
  // poster vidéo) vient d'arriver, on met à jour SUR PLACE le billboard concerné
  // au lieu de reconstruire la carte.
  useEffect(() => {
    const viewer = viewerRef.current
    const pointSource = pointSourceRef.current
    if (!viewer || viewer.isDestroyed() || !pointSource) return

    let changed = false
    pointsByEntityId.current.forEach((point, id) => {
      const { framed } = thumbForPoint(
        point,
        mediaLibraryRef.current,
        videoPostersRef.current,
        framedThumbnailsRef.current,
      )
      if (!framed || thumbAppliedRef.current.get(id) === framed) return
      const entity = pointSource.entities.getById(id)
      if (!entity?.billboard) return

      entity.billboard.image = new ConstantProperty(framed)
      entity.billboard.width = new ConstantProperty(thumbnailFrameWidth)
      entity.billboard.height = new ConstantProperty(thumbnailFrameHeight)
      entity.billboard.verticalOrigin = new ConstantProperty(VerticalOrigin.CENTER)
      thumbAppliedRef.current.set(id, framed)
      changed = true
    })
    if (changed) viewer.scene.requestRender()
  }, [framedThumbnails, videoPosters])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || recenterRequest === 0) return
    flyToTrail(viewer, track, points, 0, flat2DRef.current)
  }, [points, recenterRequest, track])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !cameraCommand) return
    // En 2D, on ignore l'inclinaison (vue du dessus verrouillée).
    if (flat2DRef.current && (cameraCommand.type === 'tilt-up' || cameraCommand.type === 'tilt-down')) {
      return
    }

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

    // On vise la hauteur réelle du terrain sous le point (sinon, en terrain 3D,
    // la cible reste au niveau de la mer et la caméra cadre à côté du marqueur).
    // Le terrain est exagéré verticalement (verticalExaggeration) : les marqueurs
    // sont posés sur le relief exagéré, donc on applique le même facteur, sinon
    // la cible est trop basse et le point finit décalé (en haut de l'écran).
    const carto = Cartographic.fromDegrees(selectedPoint.lng, selectedPoint.lat)
    const trueHeight = viewer.scene.globe.getHeight(carto) ?? 0
    const exaggeration = viewer.scene.verticalExaggeration || 1
    const relative = viewer.scene.verticalExaggerationRelativeHeight || 0
    const renderedHeight = (trueHeight - relative) * exaggeration + relative
    const target = new BoundingSphere(
      Cartesian3.fromDegrees(
        selectedPoint.lng,
        selectedPoint.lat,
        renderedHeight,
      ),
      35,
    )
    viewer.camera.flyToBoundingSphere(target, {
      duration: 1.1,
      offset: new HeadingPitchRange(
        viewer.camera.heading,
        // 2D : vue du dessus ; 3D : légèrement plongeante.
        CesiumMath.toRadians(flat2DRef.current ? -90 : -45),
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
