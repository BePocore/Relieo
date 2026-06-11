import { useState } from 'react'
import { ExternalLink, Image, MapPin, Maximize2, X } from 'lucide-react'
import type { ImportedMedia, TrailPoint } from '../types'
import { formatMediaQuality, resolvePointMedia } from '../lib/media'
import { pointTypeLabels } from '../lib/pointMeta'

type PointDetailProps = {
  point: TrailPoint
  mediaLibrary: ImportedMedia[]
  onClose: () => void
}

const MediaPreview = ({
  point,
  mediaLibrary,
}: {
  point: TrailPoint
  mediaLibrary: ImportedMedia[]
}) => {
  const media = resolvePointMedia(point, mediaLibrary)
  const [measuredMedia, setMeasuredMedia] = useState<
    Pick<
      NonNullable<ReturnType<typeof resolvePointMedia>>,
      'durationSeconds' | 'height' | 'width'
    > & { src?: string }
  >({})

  if (!media) {
    return (
      <div className="image-placeholder">
        <Image aria-hidden="true" size={32} />
      </div>
    )
  }

  if (media.kind === 'video') {
    const qualityMedia = {
      ...media,
      ...(measuredMedia.src === media.src ? measuredMedia : {}),
    }

    return (
      <>
        <video
          className="panel-image panel-video"
          src={media.src}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            setMeasuredMedia({
              src: media.src,
              width: event.currentTarget.videoWidth || media.width,
              height: event.currentTarget.videoHeight || media.height,
              durationSeconds:
                Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : media.durationSeconds,
            })
          }}
        />
        <p className="media-quality">
          Qualite source · {formatMediaQuality(qualityMedia)}
        </p>
      </>
    )
  }

  const qualityMedia = {
    ...media,
    ...(measuredMedia.src === media.src ? measuredMedia : {}),
  }

  return (
    <>
      <img
        className="panel-image"
        src={media.src}
        alt={point.title}
        decoding="async"
        onLoad={(event) => {
          setMeasuredMedia({
            src: media.src,
            width: event.currentTarget.naturalWidth || media.width,
            height: event.currentTarget.naturalHeight || media.height,
          })
        }}
      />
      <p className="media-quality">
        Qualite source · {formatMediaQuality(qualityMedia)}
      </p>
    </>
  )
}

export function PointDetail({
  point,
  mediaLibrary,
  onClose,
}: PointDetailProps) {
  const media = resolvePointMedia(point, mediaLibrary)

  return (
    <div className="panel-content">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{pointTypeLabels[point.type]}</p>
          <h2>{point.title}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Fermer"
          title="Fermer"
          onClick={onClose}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>

      <MediaPreview point={point} mediaLibrary={mediaLibrary} />

      {point.description ? (
        <p className="panel-description">{point.description}</p>
      ) : null}

      <div className="coordinate-line">
        <MapPin aria-hidden="true" size={16} />
        <span>
          {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
        </span>
      </div>

      {media ? (
        <a
          className="secondary-action media-source-action"
          href={media.src}
          target="_blank"
          rel="noreferrer"
        >
          <Maximize2 aria-hidden="true" size={17} />
          Voir le fichier original
        </a>
      ) : null}

      {point.skypixelUrl ? (
        <a
          className="primary-action"
          href={point.skypixelUrl}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink aria-hidden="true" size={17} />
          Ouvrir SkyPixel
        </a>
      ) : null}
    </div>
  )
}
