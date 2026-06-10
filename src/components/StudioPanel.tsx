import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Camera,
  Download,
  FileJson,
  FileUp,
  Image,
  List,
  LockKeyhole,
  Mountain,
  Plus,
  Save,
  UploadCloud,
  Video,
} from 'lucide-react'
import type {
  ImportedMedia,
  PointType,
  TrackPoint,
  TrailPoint,
  TrailStats,
} from '../types'
import { formatFileSize, formatMediaQuality } from '../lib/media'
import { pointTypeLabels } from '../lib/pointMeta'
import { ElevationProfile } from './ElevationProfile'
import { PointDetail } from './PointDetail'
import { PointTypeIcon } from './PointTypeIcon'

type StudioPanelProps = {
  selectedPoint: TrailPoint | null
  points: TrailPoint[]
  track: TrackPoint[]
  stats: TrailStats
  mediaLibrary: ImportedMedia[]
  trackSourceName: string
  pointsSourceName: string
  onSelectPoint: (point: TrailPoint) => void
  onClose: () => void
  onImportGpx: (file: File) => Promise<void>
  onImportPoints: (file: File) => Promise<void>
  onImportMedia: (files: File[]) => Promise<void>
  onAddPoint: (point: TrailPoint) => void
  onUpdatePoint: (point: TrailPoint) => void
  onDeletePoint: (pointId: string) => void
  onExportPoints: () => void
  onSaveProject: () => Promise<void>
  adminPassword: string
  isSaving: boolean
  isUploading: boolean
  onAdminPasswordChange: (password: string) => void
  saveStatus: string | null
}

type PanelTab = 'points' | 'import' | 'add'

type DraftPoint = {
  title: string
  type: PointType
  lat: string
  lng: string
  description: string
  skypixelUrl: string
  mediaId: string
}

const initialDraft: DraftPoint = {
  title: '',
  type: 'photo',
  lat: '',
  lng: '',
  description: '',
  skypixelUrl: '',
  mediaId: '',
}

const mediaIdForPoint = (
  point: TrailPoint,
  mediaLibrary: ImportedMedia[],
): string => {
  if (!point.mediaName) return ''
  return (
    mediaLibrary.find(
      (media) => media.name.toLowerCase() === point.mediaName?.toLowerCase(),
    )?.id ?? ''
  )
}

const draftFromPoint = (
  point: TrailPoint,
  mediaLibrary: ImportedMedia[],
): DraftPoint => {
  return {
    title: point.title,
    type: point.type,
    lat: String(point.lat),
    lng: String(point.lng),
    description: point.description ?? '',
    skypixelUrl: point.skypixelUrl ?? '',
    mediaId: mediaIdForPoint(point, mediaLibrary),
  }
}

type SelectedPointEditorProps = {
  selectedPoint: TrailPoint
  mediaLibrary: ImportedMedia[]
  onClose: () => void
  onUpdatePoint: (point: TrailPoint) => void
  onDeletePoint: (pointId: string) => void
}

function SelectedPointEditor({
  selectedPoint,
  mediaLibrary,
  onClose,
  onUpdatePoint,
  onDeletePoint,
}: SelectedPointEditorProps) {
  const [editDraft, setEditDraft] = useState(() =>
    draftFromPoint(selectedPoint, mediaLibrary),
  )
  const [editError, setEditError] = useState<string | null>(null)

  const selectedEditMedia = useMemo(
    () => mediaLibrary.find((media) => media.id === editDraft.mediaId),
    [editDraft.mediaId, mediaLibrary],
  )

  const updateEditDraft = (field: keyof DraftPoint, value: string) => {
    setEditDraft((current) => ({ ...current, [field]: value }))
    setEditError(null)
  }

  const handleUpdatePoint = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const lat = Number.parseFloat(editDraft.lat.replace(',', '.'))
    const lng = Number.parseFloat(editDraft.lng.replace(',', '.'))

    if (!editDraft.title.trim()) {
      setEditError('Ajoute un titre.')
      return
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setEditError('Coordonnees GPS invalides.')
      return
    }

    const updatedPoint: TrailPoint = {
      ...selectedPoint,
      title: editDraft.title.trim(),
      type:
        selectedEditMedia?.kind === 'video'
          ? 'video'
          : editDraft.skypixelUrl.trim()
            ? '360'
            : editDraft.type,
      lat,
      lng,
      description: editDraft.description.trim() || undefined,
      skypixelUrl: editDraft.skypixelUrl.trim() || undefined,
      image: undefined,
      video: undefined,
      mediaName: undefined,
      mediaKind: undefined,
    }

    if (selectedEditMedia) {
      updatedPoint.mediaName = selectedEditMedia.name
      updatedPoint.mediaKind = selectedEditMedia.kind

      if (selectedEditMedia.kind === 'video') {
        updatedPoint.video = selectedEditMedia.url
      } else {
        updatedPoint.image = selectedEditMedia.url
      }
    } else {
      updatedPoint.image = selectedPoint.image
      updatedPoint.video = selectedPoint.video
      updatedPoint.mediaName = selectedPoint.mediaName
      updatedPoint.mediaKind = selectedPoint.mediaKind
    }

    onUpdatePoint(updatedPoint)
  }

  return (
    <>
      <PointDetail
        point={selectedPoint}
        mediaLibrary={mediaLibrary}
        onClose={onClose}
      />

      <form
        className="panel-content point-form edit-form"
        onSubmit={handleUpdatePoint}
      >
        <div className="form-heading">
          <strong>Ajuster le point</strong>
          <button
            className="danger-action"
            type="button"
            onClick={() => {
              if (selectedPoint.id) onDeletePoint(selectedPoint.id)
            }}
          >
            Supprimer
          </button>
        </div>

        <label>
          <span>Titre</span>
          <input
            value={editDraft.title}
            onChange={(event) => updateEditDraft('title', event.target.value)}
          />
        </label>

        <label>
          <span>Type</span>
          <select
            value={editDraft.type}
            onChange={(event) =>
              updateEditDraft('type', event.target.value as PointType)
            }
          >
            <option value="photo">Photo</option>
            <option value="video">Video</option>
            <option value="360">360</option>
            <option value="poi">POI</option>
          </select>
        </label>

        <div className="field-grid">
          <label>
            <span>Latitude</span>
            <input
              inputMode="decimal"
              value={editDraft.lat}
              onChange={(event) => updateEditDraft('lat', event.target.value)}
            />
          </label>
          <label>
            <span>Longitude</span>
            <input
              inputMode="decimal"
              value={editDraft.lng}
              onChange={(event) => updateEditDraft('lng', event.target.value)}
            />
          </label>
        </div>

        <label>
          <span>Media</span>
          <select
            value={editDraft.mediaId}
            onChange={(event) =>
              updateEditDraft('mediaId', event.target.value)
            }
          >
            <option value="">Conserver / aucun media importe</option>
            {mediaLibrary.map((media) => (
              <option key={media.id} value={media.id}>
                {media.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>SkyPixel</span>
          <input
            value={editDraft.skypixelUrl}
            onChange={(event) =>
              updateEditDraft('skypixelUrl', event.target.value)
            }
          />
        </label>

        <label>
          <span>Description</span>
          <textarea
            value={editDraft.description}
            onChange={(event) =>
              updateEditDraft('description', event.target.value)
            }
            rows={4}
          />
        </label>

        {editError ? <p className="form-error">{editError}</p> : null}

        <button className="primary-action" type="submit">
          Enregistrer
        </button>
      </form>
    </>
  )
}

export function StudioPanel({
  selectedPoint,
  points,
  track,
  stats,
  mediaLibrary,
  trackSourceName,
  pointsSourceName,
  onSelectPoint,
  onClose,
  onImportGpx,
  onImportPoints,
  onImportMedia,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  onExportPoints,
  onSaveProject,
  adminPassword,
  isSaving,
  isUploading,
  onAdminPasswordChange,
  saveStatus,
}: StudioPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('points')
  const [draft, setDraft] = useState<DraftPoint>(initialDraft)
  const [formError, setFormError] = useState<string | null>(null)

  const selectedMedia = useMemo(
    () => mediaLibrary.find((media) => media.id === draft.mediaId),
    [draft.mediaId, mediaLibrary],
  )

  const updateDraft = (field: keyof DraftPoint, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setFormError(null)
  }

  const handleAddPoint = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const lat = Number.parseFloat(draft.lat.replace(',', '.'))
    const lng = Number.parseFloat(draft.lng.replace(',', '.'))

    if (!draft.title.trim()) {
      setFormError('Ajoute un titre.')
      return
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setFormError('Coordonnees GPS invalides.')
      return
    }

    const point: TrailPoint = {
      id: `point-${Date.now()}`,
      title: draft.title.trim(),
      type:
        selectedMedia?.kind === 'video'
          ? 'video'
          : draft.skypixelUrl.trim()
            ? '360'
            : draft.type,
      lat,
      lng,
      ...(draft.description.trim()
        ? { description: draft.description.trim() }
        : {}),
      ...(draft.skypixelUrl.trim()
        ? { skypixelUrl: draft.skypixelUrl.trim() }
        : {}),
    }

    if (selectedMedia) {
      point.mediaName = selectedMedia.name
      point.mediaKind = selectedMedia.kind

      if (selectedMedia.kind === 'video') {
        point.video = selectedMedia.url
      } else {
        point.image = selectedMedia.url
      }
    }

    onAddPoint(point)
    setDraft(initialDraft)
    setActiveTab('points')
  }

  if (selectedPoint) {
    return (
      <SelectedPointEditor
        key={selectedPoint.id ?? selectedPoint.title}
        selectedPoint={selectedPoint}
        mediaLibrary={mediaLibrary}
        onClose={onClose}
        onUpdatePoint={onUpdatePoint}
        onDeletePoint={onDeletePoint}
      />
    )
  }

  return (
    <div className="panel-content studio-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Studio</p>
          <h2>Préparer la randonnée</h2>
        </div>
        <Mountain aria-hidden="true" size={22} />
      </div>

      <ElevationProfile track={track} stats={stats} />

      <div className="studio-actions">
        <label className="studio-password">
          <span>
            <LockKeyhole aria-hidden="true" size={15} />
            Mot de passe Studio
          </span>
          <input
            autoComplete="current-password"
            type="password"
            value={adminPassword}
            onChange={(event) => onAdminPasswordChange(event.target.value)}
            placeholder="Mot de passe Vercel"
          />
        </label>
        <button
          className="secondary-action"
          disabled={!adminPassword || isSaving || isUploading}
          type="button"
          onClick={() => void onSaveProject()}
        >
          <Save aria-hidden="true" size={17} />
          {isSaving ? 'Publication...' : 'Publier en ligne'}
        </button>
        {saveStatus ? <p className="save-status">{saveStatus}</p> : null}
      </div>

      <div className="tabs" role="tablist" aria-label="Sections du studio">
        <button
          className={activeTab === 'points' ? 'tab-button active' : 'tab-button'}
          type="button"
          onClick={() => setActiveTab('points')}
        >
          <List aria-hidden="true" size={16} />
          Points
        </button>
        <button
          className={activeTab === 'import' ? 'tab-button active' : 'tab-button'}
          type="button"
          onClick={() => setActiveTab('import')}
        >
          <UploadCloud aria-hidden="true" size={16} />
          Import
        </button>
        <button
          className={activeTab === 'add' ? 'tab-button active' : 'tab-button'}
          type="button"
          onClick={() => setActiveTab('add')}
        >
          <Plus aria-hidden="true" size={16} />
          Ajouter
        </button>
      </div>

      {activeTab === 'points' ? (
        <div className="point-list">
          {points.length === 0 ? (
            <div className="empty-state">Aucun point pour le moment.</div>
          ) : null}

          {points.map((point) => (
            <button
              className="point-row"
              key={point.id ?? point.title}
              type="button"
              onClick={() => onSelectPoint(point)}
            >
              <span className={`type-dot type-${point.type}`}>
                <PointTypeIcon type={point.type} />
              </span>
              <span>
                <strong>{point.title}</strong>
                <small>{pointTypeLabels[point.type]}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === 'import' ? (
        <div className="import-grid">
          <label className="upload-tile">
            <FileUp aria-hidden="true" size={22} />
            <span>
              <strong>Trace GPX</strong>
              <small>{trackSourceName}</small>
            </span>
            <input
              type="file"
              accept=".gpx,application/gpx+xml,text/xml,application/xml"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void onImportGpx(file)
                event.currentTarget.value = ''
              }}
            />
          </label>

          <label className="upload-tile">
            <FileJson aria-hidden="true" size={22} />
            <span>
              <strong>Points JSON</strong>
              <small>{pointsSourceName}</small>
            </span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void onImportPoints(file)
                event.currentTarget.value = ''
              }}
            />
          </label>

          <label className="upload-tile">
            <Image aria-hidden="true" size={22} />
            <span>
              <strong>Photos / vidéos</strong>
              <small>
                {isUploading
                  ? 'Envoi vers Vercel...'
                  : adminPassword
                    ? `${mediaLibrary.length} média(s)`
                    : 'Mot de passe Studio requis'}
              </small>
            </span>
            <input
              type="file"
              accept="image/*,video/*,.heic,.heif,.mp4,.mov,.m4v,image/heic,image/heif,video/mp4,video/quicktime"
              disabled={!adminPassword || isUploading}
              multiple
              onChange={(event) => {
                void onImportMedia(Array.from(event.target.files ?? []))
                event.currentTarget.value = ''
              }}
            />
          </label>

          <button
            className="secondary-action"
            type="button"
            onClick={onExportPoints}
          >
            <Download aria-hidden="true" size={17} />
            Exporter points.json
          </button>

          <div className="media-list">
            {mediaLibrary.length === 0 ? (
              <div className="empty-state">Aucun média importé.</div>
            ) : null}

            {mediaLibrary.map((media) => (
              <div className="media-row" key={media.id}>
                <span className={`type-dot type-${media.kind}`}>
                  {media.kind === 'video' ? (
                    <Video aria-hidden="true" size={16} />
                  ) : (
                    <Camera aria-hidden="true" size={16} />
                  )}
                </span>
                <span>
                  <strong>{media.name}</strong>
                  <small>
                    {formatFileSize(media.size)} · {formatMediaQuality(media)}
                    {media.lat !== undefined && media.lng !== undefined
                      ? ` · ${
                          media.locationSource === 'video-metadata'
                            ? 'GPS video'
                            : 'GPS EXIF'
                        } ${media.lat.toFixed(5)}, ${media.lng.toFixed(5)}`
                      : ' · pas de GPS'}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {activeTab === 'add' ? (
        <form className="point-form" onSubmit={handleAddPoint}>
          <label>
            <span>Titre</span>
            <input
              value={draft.title}
              onChange={(event) => updateDraft('title', event.target.value)}
              placeholder="Belvédère"
            />
          </label>

          <label>
            <span>Type</span>
            <select
              value={draft.type}
              onChange={(event) =>
                updateDraft('type', event.target.value as PointType)
              }
            >
              <option value="photo">Photo</option>
              <option value="video">Video</option>
              <option value="360">360</option>
              <option value="poi">POI</option>
            </select>
          </label>

          <div className="field-grid">
            <label>
              <span>Latitude</span>
              <input
                inputMode="decimal"
                value={draft.lat}
                onChange={(event) => updateDraft('lat', event.target.value)}
                placeholder="45.92308"
              />
            </label>
            <label>
              <span>Longitude</span>
              <input
                inputMode="decimal"
                value={draft.lng}
                onChange={(event) => updateDraft('lng', event.target.value)}
                placeholder="6.87266"
              />
            </label>
          </div>

          <label>
            <span>Média</span>
            <select
              value={draft.mediaId}
              onChange={(event) => updateDraft('mediaId', event.target.value)}
            >
              <option value="">Aucun média</option>
              {mediaLibrary.map((media) => (
                <option key={media.id} value={media.id}>
                  {media.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>SkyPixel</span>
            <input
              value={draft.skypixelUrl}
              onChange={(event) =>
                updateDraft('skypixelUrl', event.target.value)
              }
              placeholder="https://www.skypixel.com/..."
            />
          </label>

          <label>
            <span>Description</span>
            <textarea
              value={draft.description}
              onChange={(event) =>
                updateDraft('description', event.target.value)
              }
              rows={4}
              placeholder="Quelques mots sur le point."
            />
          </label>

          {formError ? <p className="form-error">{formError}</p> : null}

          <button className="primary-action" type="submit">
            <Plus aria-hidden="true" size={17} />
            Ajouter le point
          </button>
        </form>
      ) : null}
    </div>
  )
}
