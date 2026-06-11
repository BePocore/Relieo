import { useState } from 'react'
import {
  ExternalLink,
  Image,
  Lock,
  LockOpen,
  MapPin,
  Maximize2,
  Trash2,
  X,
} from 'lucide-react'
import type { ImportedMedia, TrailPoint } from '../types'
import type { LightboxMedia } from '../App'
import { formatMediaQuality, resolvePointMedia } from '../lib/media'
import { pointTypeLabels } from '../lib/pointMeta'

type PointDetailProps = {
  point: TrailPoint
  mediaLibrary: ImportedMedia[]
  onClose: () => void
  onShowMedia?: (media: LightboxMedia) => void
  editable?: boolean
  onDelete?: (pointId: string) => void
  onToggleLock?: (pointId: string) => void
}

const MediaPreview = ({
  point,
  mediaLibrary,
  onShowMedia,
}: {
  point: TrailPoint
  mediaLibrary: ImportedMedia[]
  onShowMedia?: (media: LightboxMedia) => void
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
      <button
        className="panel-image-button"
        type="button"
        aria-label="Voir la photo en grand"
        onClick={() =>
          onShowMedia?.({ src: media.src, kind: 'image', title: point.title })
        }
      >
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
        <span className="panel-image-zoom" aria-hidden="true">
          <Maximize2 size={16} />
        </span>
      </button>
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
  onShowMedia,
  editable = false,
  onDelete,
  onToggleLock,
}: PointDetailProps) {
  const media = resolvePointMedia(point, mediaLibrary)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const canDelete = editable && Boolean(onDelete) && Boolean(point.id)
  const canLock = editable && Boolean(onToggleLock) && Boolean(point.id)
  const isLocked = point.locked !== false

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

      <MediaPreview
        point={point}
        mediaLibrary={mediaLibrary}
        onShowMedia={onShowMedia}
      />

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
        <button
          className="secondary-action media-source-action"
          type="button"
          onClick={() =>
            onShowMedia?.({
              src: media.src,
              kind: media.kind,
              title: point.title,
            })
          }
        >
          <Maximize2 aria-hidden="true" size={17} />
          Voir le fichier original
        </button>
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

      {canLock ? (
        <button
          className={
            isLocked
              ? 'secondary-action lock-action'
              : 'secondary-action lock-action unlocked'
          }
          type="button"
          aria-pressed={!isLocked}
          onClick={() => {
            if (point.id) onToggleLock?.(point.id)
          }}
        >
          {isLocked ? (
            <>
              <Lock aria-hidden="true" size={16} />
              Verrouillé · déverrouiller pour déplacer
            </>
          ) : (
            <>
              <LockOpen aria-hidden="true" size={16} />
              Déverrouillé · glisser sur la carte
            </>
          )}
        </button>
      ) : null}

      {canDelete ? (
        <button
          className="danger-action point-delete-action"
          type="button"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 aria-hidden="true" size={16} />
          Supprimer ce point
        </button>
      ) : null}

      {confirmingDelete ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-card">
            <strong>Supprimer ce point ?</strong>
            <p>Cette action est définitive.</p>
            <div className="confirm-actions">
              <button
                className="secondary-action"
                type="button"
                onClick={() => setConfirmingDelete(false)}
              >
                Annuler
              </button>
              <button
                className="danger-action"
                type="button"
                onClick={() => {
                  setConfirmingDelete(false)
                  if (point.id) onDelete?.(point.id)
                }}
              >
                <Trash2 aria-hidden="true" size={16} />
                Supprimer
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
