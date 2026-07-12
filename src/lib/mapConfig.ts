import type { MapConfig, MapKind, MapViewMode } from '../types'
import { basemapOptions, defaultBasemap, type BasemapId } from './basemaps'

// ---------------------------------------------------------------------------
// Réglages de la carte (TrailProject.mapConfig) : type de carte (figé à la
// création), mode de vue 2D/3D et fond de carte par défaut. Aides partagées
// entre App.tsx, le StudioPanel (réglages) et la modale de création du
// dashboard. Comme pour le diaporama : on ne persiste que ce qui diffère du
// défaut, une carte jamais personnalisée n'a pas de champ `mapConfig`.
// ---------------------------------------------------------------------------

export const DEFAULT_MAP_KIND: MapKind = 'hike'
export const DEFAULT_VIEW_MODE: MapViewMode = 'both'

export const isMapKind = (value: unknown): value is MapKind =>
  value === 'hike' || value === 'gallery'

export const isMapViewMode = (value: unknown): value is MapViewMode =>
  value === 'both' || value === '2d' || value === '3d'

export const isBasemapId = (value: unknown): value is BasemapId =>
  basemapOptions.some((option) => option.id === value)

export const mapKindLabel = (kind: MapKind): string =>
  kind === 'gallery' ? 'Exposition de photos' : 'Randonnée'

// Fond d'ouverture effectif d'une carte (réglage validé, sinon défaut global).
export const configBasemap = (config: MapConfig): BasemapId =>
  isBasemapId(config.defaultBasemap) ? config.defaultBasemap : defaultBasemap

export const cleanMapConfig = (config: MapConfig): MapConfig | undefined => {
  const cleaned: MapConfig = {}
  if (isMapKind(config.kind) && config.kind !== DEFAULT_MAP_KIND) {
    cleaned.kind = config.kind
  }
  if (isMapViewMode(config.viewMode) && config.viewMode !== DEFAULT_VIEW_MODE) {
    cleaned.viewMode = config.viewMode
  }
  if (
    isBasemapId(config.defaultBasemap) &&
    config.defaultBasemap !== defaultBasemap
  ) {
    cleaned.defaultBasemap = config.defaultBasemap
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}
