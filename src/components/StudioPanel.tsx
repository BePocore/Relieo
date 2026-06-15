import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Camera,
  Cloud,
  Download,
  FileJson,
  FileUp,
  HardDrive,
  Image,
  KeyRound,
  List,
  LockKeyhole,
  MapPinOff,
  Mountain,
  Plus,
  Route,
  Trash2,
  TriangleAlert,
  UploadCloud,
  Video,
  X,
} from 'lucide-react'
import type {
  ImportedMedia,
  ImportReport,
  PointType,
  Trace,
  TrailPoint,
  TrailStats,
  UploadProgress,
} from '../types'
import type { LightboxMedia } from '../App'
import { formatFileSize, formatMediaQuality } from '../lib/media'
import { pointTypeLabels } from '../lib/pointMeta'
import { ElevationProfile } from './ElevationProfile'
import { PointDetail } from './PointDetail'
import { PointTypeIcon } from './PointTypeIcon'
import { ColorSwatches } from './ColorSwatches'
import { paletteColors, traceColor } from '../lib/mapStyles'
import { newPointTitle } from '../App'
import { firebaseEnabled } from '../portal/firebase'

type StudioPanelProps = {
  selectedPoint: TrailPoint | null
  points: TrailPoint[]
  traces: Trace[]
  stats: TrailStats
  mediaLibrary: ImportedMedia[]
  pointsSourceName: string
  accessCode: string
  onSelectPoint: (point: TrailPoint) => void
  onClose: () => void
  onImportGpx: (files: File[]) => Promise<void>
  onDeleteTrace: (traceId: string) => void
  onRenameTrace: (traceId: string, name: string) => void
  onSetTraceColor: (traceId: string, color: string) => void
  onImportPoints: (file: File) => Promise<void>
  onImportMedia: (files: File[]) => Promise<void>
  onAttachMedia: (pointId: string, file: File) => Promise<void>
  onAddPoint: (point: TrailPoint) => void
  onUpdatePoint: (point: TrailPoint) => void
  onDeletePoint: (pointId: string) => void
  onToggleLock: (pointId: string) => void
  onSetPointColor: (pointId: string, color: string) => void
  onExportPoints: () => void
  onSaveProject: () => Promise<void>
  onShowMedia: (media: LightboxMedia) => void
  adminPassword: string
  isSaving: boolean
  isUploading: boolean
  uploadProgress: UploadProgress | null
  importReport: ImportReport | null
  onDismissReport: () => void
  onAccessCodeChange: (code: string) => void
  onAdminPasswordChange: (password: string) => void
  onDraftDirtyChange: (dirty: boolean) => void
  saveStatus: string | null
}

type ReportSection = {
  key: string
  title: string
  icon: ReactNode
  tone: 'ok' | 'warn' | 'error'
  entries: ImportReport['placed']
}

function ImportReportCard({
  report,
  onDismiss,
}: {
  report: ImportReport
  onDismiss: () => void
}) {
  const allSections: ReportSection[] = [
    {
      key: 'noGps',
      title: 'Sans position GPS',
      icon: <MapPinOff aria-hidden="true" size={15} />,
      tone: 'warn',
      entries: report.noGps,
    },
    {
      key: 'offTrack',
      title: 'Position douteuse',
      icon: <TriangleAlert aria-hidden="true" size={15} />,
      tone: 'warn',
      entries: report.offTrack,
    },
    {
      key: 'duplicates',
      title: 'Deja presents',
      icon: <HardDrive aria-hidden="true" size={15} />,
      tone: 'ok',
      entries: report.duplicates,
    },
    {
      key: 'failed',
      title: 'Échec d’envoi',
      icon: <TriangleAlert aria-hidden="true" size={15} />,
      tone: 'error',
      entries: report.failed,
    },
  ]
  const sections = allSections.filter((section) => section.entries.length > 0)

  return (
    <div className="import-report" role="status">
      <div className="import-report-head">
        <strong>
          Rapport d’import · {report.placed.length}/{report.total} placé(s)
        </strong>
        <button
          aria-label="Fermer le rapport"
          className="import-report-close"
          type="button"
          onClick={onDismiss}
        >
          <X aria-hidden="true" size={15} />
        </button>
      </div>

      {sections.length === 0 ? (
        <p className="import-report-empty">
          Tous les médias géolocalisés ont été placés sur le tracé.
        </p>
      ) : (
        sections.map((section) => (
          <div
            className={`import-report-section tone-${section.tone}`}
            key={section.key}
          >
            <div className="import-report-section-head">
              {section.icon}
              <span>
                {section.title} · {section.entries.length}
              </span>
            </div>
            <ul>
              {section.entries.map((entry) => (
                <li key={entry.name}>
                  <span className="import-report-name">{entry.name}</span>
                  {entry.detail ? (
                    <small>{entry.detail}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  )
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
  isUploading: boolean
  onClose: () => void
  onShowMedia: (media: LightboxMedia) => void
  onAttachMedia: (pointId: string, file: File) => Promise<void>
  onUpdatePoint: (point: TrailPoint) => void
  onDeletePoint: (pointId: string) => void
  onToggleLock: (pointId: string) => void
  onSetPointColor: (pointId: string, color: string) => void
  onDraftDirtyChange: (dirty: boolean) => void
}

function SelectedPointEditor({
  selectedPoint,
  mediaLibrary,
  isUploading,
  onClose,
  onShowMedia,
  onAttachMedia,
  onUpdatePoint,
  onDeletePoint,
  onToggleLock,
  onSetPointColor,
  onDraftDirtyChange,
}: SelectedPointEditorProps) {
  const originalDraft = useMemo(
    () => draftFromPoint(selectedPoint, mediaLibrary),
    [mediaLibrary, selectedPoint],
  )
  const [editDraft, setEditDraft] = useState(() => originalDraft)
  const [editError, setEditError] = useState<string | null>(null)

  useEffect(() => {
    onDraftDirtyChange(
      JSON.stringify(editDraft) !== JSON.stringify(originalDraft),
    )
  }, [editDraft, onDraftDirtyChange, originalDraft])

  useEffect(
    () => () => {
      onDraftDirtyChange(false)
    },
    [onDraftDirtyChange],
  )

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
        onShowMedia={onShowMedia}
        editable
        onDelete={onDeletePoint}
        onToggleLock={onToggleLock}
        onClose={onClose}
      />

      <form
        className="panel-content point-form edit-form"
        onSubmit={handleUpdatePoint}
      >
        <div className="form-heading">
          <strong>Ajuster le point</strong>
        </div>

        {selectedPoint.id ? (
          <label className="attach-media-action">
            <UploadCloud aria-hidden="true" size={17} />
            {isUploading
              ? 'Envoi en cours...'
              : 'Importer une photo / vidéo pour ce point'}
            <input
              type="file"
              accept="image/*,video/*"
              disabled={isUploading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file && selectedPoint.id) {
                  void onAttachMedia(selectedPoint.id, file)
                }
              }}
            />
          </label>
        ) : null}

        <label>
          <span>Titre</span>
          <input
            value={editDraft.title}
            placeholder="Nom du point"
            onFocus={(event) => {
              // Le titre par défaut s'efface dès qu'on commence à nommer.
              if (editDraft.title === newPointTitle) {
                updateEditDraft('title', '')
                event.target.value = ''
              }
            }}
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

        <label className="color-field">
          <span>Couleur du point</span>
          <ColorSwatches
            colors={paletteColors}
            value={selectedPoint.color}
            onSelect={(color) => {
              if (selectedPoint.id) onSetPointColor(selectedPoint.id, color)
            }}
          />
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
          Appliquer les modifications
        </button>
      </form>
    </>
  )
}

export function StudioPanel({
  selectedPoint,
  points,
  traces,
  stats,
  mediaLibrary,
  pointsSourceName,
  accessCode,
  onSelectPoint,
  onClose,
  onImportGpx,
  onDeleteTrace,
  onRenameTrace,
  onSetTraceColor,
  onImportPoints,
  onImportMedia,
  onAttachMedia,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  onToggleLock,
  onSetPointColor,
  onExportPoints,
  onSaveProject,
  onShowMedia,
  onAccessCodeChange,
  adminPassword,
  isSaving,
  isUploading,
  uploadProgress,
  importReport,
  onDismissReport,
  onAdminPasswordChange,
  onDraftDirtyChange,
  saveStatus,
}: StudioPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('points')
  const [draft, setDraft] = useState<DraftPoint>(initialDraft)
  const [formError, setFormError] = useState<string | null>(null)
  const [paletteTraceId, setPaletteTraceId] = useState<string | null>(null)
  const writeAuthReady = firebaseEnabled || Boolean(adminPassword)

  const selectedMedia = useMemo(
    () => mediaLibrary.find((media) => media.id === draft.mediaId),
    [draft.mediaId, mediaLibrary],
  )
  const addDraftIsDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialDraft),
    [draft],
  )

  useEffect(() => {
    if (!selectedPoint) onDraftDirtyChange(addDraftIsDirty)
  }, [addDraftIsDirty, onDraftDirtyChange, selectedPoint])

  useEffect(
    () => () => {
      onDraftDirtyChange(false)
    },
    [onDraftDirtyChange],
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
        isUploading={isUploading}
        onClose={onClose}
        onShowMedia={onShowMedia}
        onAttachMedia={onAttachMedia}
        onUpdatePoint={onUpdatePoint}
        onDeletePoint={onDeletePoint}
        onToggleLock={onToggleLock}
        onSetPointColor={onSetPointColor}
        onDraftDirtyChange={onDraftDirtyChange}
      />
    )
  }

  return (
    <div className="panel-content studio-panel">
      <div className="panel-heading studio-heading">
        <div>
          <span className="studio-badge">Studio</span>
          <h2>Préparer la carte</h2>
        </div>
        <Mountain aria-hidden="true" size={22} />
      </div>

      <ElevationProfile traces={traces} stats={stats} />

      <div className="studio-actions">
        {firebaseEnabled ? (
          <div className="studio-password">
            <span>
              <LockKeyhole aria-hidden="true" size={15} />
              Compte Firebase connecté
            </span>
          </div>
        ) : (
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
              placeholder="Mot de passe Studio"
            />
          </label>
        )}
        <label className="studio-password">
          <span>
            <KeyRound aria-hidden="true" size={15} />
            Code carte / accès visiteurs
          </span>
          <input
            autoComplete="off"
            type="text"
            value={accessCode}
            onChange={(event) => onAccessCodeChange(event.target.value)}
            placeholder="Exemple : Halsa"
          />
        </label>
        <button
          className="primary-action"
          disabled={!writeAuthReady || !accessCode.trim() || isSaving || isUploading}
          type="button"
          onClick={() => void onSaveProject()}
        >
          <Cloud aria-hidden="true" size={17} />
          {isSaving ? 'Publication...' : 'Publier en ligne'}
        </button>
        {uploadProgress ? (
          <div className="upload-progress" role="status">
            <div className="upload-progress-info">
              <span>
                Envoi {uploadProgress.fileIndex}/{uploadProgress.fileCount} ·{' '}
                {uploadProgress.fileName}
              </span>
              <strong>{uploadProgress.percentage}%</strong>
            </div>
            <div
              className="upload-progress-track"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={uploadProgress.percentage}
              role="progressbar"
            >
              <div
                className="upload-progress-fill"
                style={{ width: `${uploadProgress.percentage}%` }}
              />
            </div>
          </div>
        ) : null}
        {saveStatus ? <p className="save-status">{saveStatus}</p> : null}
        {importReport ? (
          <ImportReportCard
            report={importReport}
            onDismiss={onDismissReport}
          />
        ) : null}
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
              <strong>Traces GPX</strong>
              <small>
                {traces.length > 0
                  ? `${traces.length} trace(s) · ajouter`
                  : 'Importer une ou plusieurs traces'}
              </small>
            </span>
            <input
              type="file"
              accept=".gpx,application/gpx+xml,text/xml,application/xml"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                if (files.length > 0) void onImportGpx(files)
                event.currentTarget.value = ''
              }}
            />
          </label>

          {traces.length > 0 ? (
            <div className="trace-list">
              {traces.map((trace, index) => {
                const color = trace.color ?? traceColor(index)
                return (
                  <div className="trace-item" key={trace.id}>
                    <div className="trace-row">
                      <button
                        className="trace-color"
                        style={{ background: color }}
                        type="button"
                        aria-label="Changer la couleur de la trace"
                        title="Couleur de la trace"
                        onClick={() =>
                          setPaletteTraceId((current) =>
                            current === trace.id ? null : trace.id,
                          )
                        }
                      />
                      <Route aria-hidden="true" size={15} />
                      <input
                        className="trace-name"
                        value={trace.name}
                        aria-label="Nom de la trace"
                        onChange={(event) =>
                          onRenameTrace(trace.id, event.target.value)
                        }
                      />
                      <button
                        className="trace-delete"
                        type="button"
                        aria-label={`Supprimer ${trace.name}`}
                        title="Supprimer la trace"
                        onClick={() => onDeleteTrace(trace.id)}
                      >
                        <Trash2 aria-hidden="true" size={15} />
                      </button>
                    </div>
                    {paletteTraceId === trace.id ? (
                      <ColorSwatches
                        colors={paletteColors}
                        value={color}
                        onSelect={(selected) => {
                          onSetTraceColor(trace.id, selected)
                          setPaletteTraceId(null)
                        }}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}

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
                  ? 'Envoi vers le stockage...'
                  : writeAuthReady && accessCode.trim()
                    ? `${mediaLibrary.length} média(s)`
                    : 'Connexion et code carte requis'}
              </small>
            </span>
            <input
              type="file"
              accept="image/*,video/*,.heic,.heif,.mp4,.mov,.m4v,image/heic,image/heif,video/mp4,video/quicktime"
              disabled={!writeAuthReady || !accessCode.trim() || isUploading}
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
