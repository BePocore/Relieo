import { Layers, Map, Mountain, Satellite } from 'lucide-react'
import { basemapOptions, type BasemapId } from '../lib/basemaps'

type BasemapControlProps = {
  basemap: BasemapId
  onChange: (basemap: BasemapId) => void
}

const iconForBasemap = (basemap: BasemapId) => {
  if (basemap === 'satellite') return <Satellite aria-hidden="true" size={15} />
  if (basemap === 'topo') return <Mountain aria-hidden="true" size={15} />
  return <Map aria-hidden="true" size={15} />
}

export function BasemapControl({ basemap, onChange }: BasemapControlProps) {
  return (
    <div className="basemap-control" aria-label="Fond de carte">
      <div className="basemap-title">
        <Layers aria-hidden="true" size={15} />
        <span>Fond</span>
      </div>
      <div className="basemap-buttons">
        {basemapOptions.map((option) => (
          <button
            aria-pressed={basemap === option.id}
            className={
              basemap === option.id
                ? 'basemap-button active'
                : 'basemap-button'
            }
            key={option.id}
            title={option.description}
            type="button"
            onClick={() => onChange(option.id)}
          >
            {iconForBasemap(option.id)}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
