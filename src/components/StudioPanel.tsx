import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, KeyboardEvent, PointerEvent, ReactNode } from 'react'
import {
  Camera,
  CheckCircle2,
  FileUp,
  GripVertical,
  HardDrive,
  Image,
  Info,
  KeyRound,
  List,
  LockKeyhole,
  LoaderCircle,
  MapPinOff,
  Mountain,
  Plus,
  Route,
  Satellite,
  Save,
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
import type { UserTraceRecord } from '../portal/userTraces'

type StudioPanelProps = {
  selectedPoint: TrailPoint | null
  points: TrailPoint[]
  traces: Trace[]
  stats: TrailStats
  mediaLibrary: ImportedMedia[]
  accessCode: string
  onSelectPoint: (point: TrailPoint) => void
  onClose: () => void
  onImportGpx: (files: File[]) => Promise<void>
  onDeleteTrace: (traceId: string) => void
  onRenameTrace: (traceId: string, name: string) => void
  onReorderTrace: (draggedTraceId: string, targetTraceId: string) => void
  onSetTraceColor: (traceId: string, color: string) => void
  onImportDriveMedia: () => Promise<void>
  onImportMedia: (files: File[]) => Promise<void>
  onCleanupUnusedMedia: () => Promise<void>
  onDeleteMedia: (mediaId: string) => Promise<void>
  onAcceptEstimatedMedia: (mediaId: string) => void
  onEstimateImportedMedia: (mediaId: string) => void
  onIgnoreImportEntry: (
    section: 'noGps' | 'offTrack' | 'duplicates' | 'failed',
    entry: ImportReport['placed'][number],
  ) => void
  onPlaceImportedMedia: (mediaId: string) => void
  onAttachMedia: (pointId: string, file: File) => Promise<void>
  onAddPoint: (point: TrailPoint) => void
  onUpdatePoint: (point: TrailPoint) => void
  onDeletePoint: (pointId: string) => void
  onToggleLock: (pointId: string) => void
  onSetPointColor: (pointId: string, color: string) => void
  onLoadRelioTraces: () => Promise<UserTraceRecord[]>
  onImportRelioTrace: (trace: UserTraceRecord) => void
  onSaveProject: () => Promise<void>
  onShowMedia: (media: LightboxMedia) => void
  adminPassword: string
  isSaving: boolean
  isUploading: boolean
  isDriveImporting: boolean
  isCleaningUnusedMedia: boolean
  deletingMediaId: string | null
  canEstimatePlacement: boolean
  googleDriveConfigured: boolean
  uploadProgress: UploadProgress | null
  importReport: ImportReport | null
  onDismissReport: () => void
  onAccessCodeChange: (code: string) => void
  onAdminPasswordChange: (password: string) => void
  onDraftDirtyChange: (dirty: boolean) => void
  saveStatus: string | null
  isPublished: boolean
}

type ReportSection = {
  key: 'noGps' | 'offTrack' | 'duplicates' | 'failed'
  title: string
  icon: ReactNode
  tone: 'ok' | 'warn' | 'error'
  entries: ImportReport['placed']
}

type SaveStatusTone = 'success' | 'error' | 'busy' | 'info'

const getSaveStatusTone = (status: string): SaveStatusTone => {
  const normalized = status.toLocaleLowerCase('fr-FR')

  if (
    [
      'impossible',
      'introuvable',
      'requis',
      'obligatoire',
      'non reconnu',
      'refus',
      'erreur',
      'échec',
      'echec',
    ].some((pattern) => normalized.includes(pattern))
  ) {
    return 'error'
  }

  if (
    [
      'analyse',
      'envoi',
      'recherche',
      'ouverture',
      'suppression',
      'sauvegarde...',
      'sauvegarde automatique',
      'nettoyage',
    ].some((pattern) => normalized.includes(pattern))
  ) {
    return 'busy'
  }

  if (
    [
      'sauvegard',
      'enregistr',
      'supprim',
      'placé',
      'place',
      'attaché',
      'attache',
      'copié',
      'copie',
      'aucun fichier inutilisé',
    ].some((pattern) => normalized.includes(pattern))
  ) {
    return 'success'
  }

  return 'info'
}

function ImportReportCard({
  report,
  onDismiss,
  canEstimatePlacement,
  onAcceptEstimate,
  onEstimateMedia,
  onIgnoreEntry,
  onPlaceMedia,
}: {
  report: ImportReport
  onDismiss: () => void
  canEstimatePlacement: boolean
  onAcceptEstimate: (mediaId: string) => void
  onEstimateMedia: (mediaId: string) => void
  onIgnoreEntry: (
    section: 'noGps' | 'offTrack' | 'duplicates' | 'failed',
    entry: ImportReport['placed'][number],
  ) => void
  onPlaceMedia: (mediaId: string) => void
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
                  <span className="import-report-item-main">
                    <span className="import-report-name">{entry.name}</span>
                    {entry.placementEstimate ? (
                      <small>{entry.placementEstimate.detail}</small>
                    ) : null}
                    {entry.detail ? (
                      <small>{entry.detail}</small>
                    ) : null}
                  </span>
                  <span className="import-report-entry-actions">
                    {section.key === 'noGps' && entry.mediaId ? (
                      entry.placementEstimate ? (
                        <>
                          <button
                            className="import-report-action"
                            type="button"
                            onClick={() =>
                              onAcceptEstimate(entry.mediaId as string)
                            }
                          >
                            Valider
                          </button>
                          <button
                            className="import-report-action secondary"
                            type="button"
                            onClick={() =>
                              onPlaceMedia(entry.mediaId as string)
                            }
                          >
                            Placement manuel
                          </button>
                        </>
                      ) : canEstimatePlacement && !entry.estimateUnavailable ? (
                        <button
                          className="import-report-action"
                          type="button"
                          onClick={() =>
                            onEstimateMedia(entry.mediaId as string)
                          }
                        >
                          Déduire
                        </button>
                      ) : (
                        <button
                          className="import-report-action"
                          type="button"
                          onClick={() =>
                            onPlaceMedia(entry.mediaId as string)
                          }
                        >
                          <Plus aria-hidden="true" size={13} />
                          Placement manuel
                        </button>
                      )
                    ) : section.key === 'offTrack' && entry.mediaId ? (
                      <button
                        className="import-report-action"
                        type="button"
                        onClick={() => onPlaceMedia(entry.mediaId as string)}
                      >
                        <Plus aria-hidden="true" size={13} />
                        Placement manuel
                      </button>
                    ) : null}
                    <button
                      className="import-report-ignore"
                      type="button"
                      aria-label={`Ignorer ${entry.name}`}
                      title="Ignorer ce fichier"
                      onClick={() => onIgnoreEntry(section.key, entry)}
                    >
                      <X aria-hidden="true" size={13} />
                    </button>
                  </span>
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
  accessCode,
  onSelectPoint,
  onClose,
  onImportGpx,
  onDeleteTrace,
  onRenameTrace,
  onReorderTrace,
  onSetTraceColor,
  onImportDriveMedia,
  onImportMedia,
  onCleanupUnusedMedia,
  onDeleteMedia,
  onAcceptEstimatedMedia,
  onEstimateImportedMedia,
  onIgnoreImportEntry,
  onPlaceImportedMedia,
  onAttachMedia,
  onAddPoint,
  onUpdatePoint,
  onDeletePoint,
  onToggleLock,
  onSetPointColor,
  onLoadRelioTraces,
  onImportRelioTrace,
  onSaveProject,
  onShowMedia,
  onAccessCodeChange,
  adminPassword,
  isSaving,
  isUploading,
  isDriveImporting,
  isCleaningUnusedMedia,
  deletingMediaId,
  canEstimatePlacement,
  googleDriveConfigured,
  uploadProgress,
  importReport,
  onDismissReport,
  onAdminPasswordChange,
  onDraftDirtyChange,
  saveStatus,
  isPublished,
}: StudioPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('points')
  const [draft, setDraft] = useState<DraftPoint>(initialDraft)
  const [formError, setFormError] = useState<string | null>(null)
  const [paletteTraceId, setPaletteTraceId] = useState<string | null>(null)
  const [dragTraceId, setDragTraceId] = useState<string | null>(null)
  const [dragOverTraceId, setDragOverTraceId] = useState<string | null>(null)
  const [relioPickerOpen, setRelioPickerOpen] = useState(false)
  const [relioTraces, setRelioTraces] = useState<UserTraceRecord[]>([])
  const [relioLoading, setRelioLoading] = useState(false)
  const [relioError, setRelioError] = useState<string | null>(null)
  const writeAuthReady = firebaseEnabled || Boolean(adminPassword)

  const toggleRelioPicker = () => {
    const next = !relioPickerOpen
    setRelioPickerOpen(next)
    if (!next) return
    setRelioLoading(true)
    setRelioError(null)
    onLoadRelioTraces()
      .then((items) => setRelioTraces(items))
      .catch((loadError: unknown) =>
        setRelioError(
          loadError instanceof Error
            ? loadError.message
            : 'Lecture des traces impossible.',
        ),
      )
      .finally(() => setRelioLoading(false))
  }
  const driveImportDisabled =
    !googleDriveConfigured ||
    !writeAuthReady ||
    !accessCode.trim() ||
    isUploading ||
    isDriveImporting
  const driveImportHint = !googleDriveConfigured
    ? 'Configuration Google requise'
    : isDriveImporting
      ? 'Ouverture de Google Drive...'
      : isUploading
        ? 'Envoi vers le stockage...'
        : writeAuthReady && accessCode.trim()
          ? 'Choisir des photos / vidéos'
          : 'Connexion et code carte requis'
  const saveStatusTone = saveStatus ? getSaveStatusTone(saveStatus) : null
  const saveStatusIcon =
    saveStatusTone === 'error' ? (
      <TriangleAlert aria-hidden="true" size={18} />
    ) : saveStatusTone === 'success' ? (
      <CheckCircle2 aria-hidden="true" size={18} />
    ) : saveStatusTone === 'busy' ? (
      <LoaderCircle aria-hidden="true" className="save-status-spinner" size={18} />
    ) : (
      <Info aria-hidden="true" size={18} />
    )

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

  const handleTraceHandleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    traceId: string,
    index: number,
  ) => {
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault()
      onReorderTrace(traceId, traces[index - 1].id)
    }
    if (event.key === 'ArrowDown' && index < traces.length - 1) {
      event.preventDefault()
      onReorderTrace(traceId, traces[index + 1].id)
    }
  }

  const traceIdFromPointer = (clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY)
    return (
      element?.closest<HTMLElement>('[data-trace-id]')?.dataset.traceId ?? null
    )
  }

  const handleTracePointerDown = (
    event: PointerEvent<HTMLButtonElement>,
    traceId: string,
  ) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragTraceId(traceId)
    setDragOverTraceId(null)
  }

  const handleTracePointerMove = (
    event: PointerEvent<HTMLButtonElement>,
    sourceTraceId: string,
  ) => {
    if (dragTraceId !== sourceTraceId) return
    event.preventDefault()
    const targetTraceId = traceIdFromPointer(event.clientX, event.clientY)
    setDragOverTraceId(
      targetTraceId && targetTraceId !== sourceTraceId ? targetTraceId : null,
    )
  }

  const handleTracePointerEnd = (
    event: PointerEvent<HTMLButtonElement>,
    sourceTraceId: string,
  ) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const targetTraceId = traceIdFromPointer(event.clientX, event.clientY)
    setDragTraceId(null)
    setDragOverTraceId(null)
    if (!targetTraceId || targetTraceId === sourceTraceId) return
    onReorderTrace(sourceTraceId, targetTraceId)
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
          disabled={
            !writeAuthReady ||
            !accessCode.trim() ||
            isSaving ||
            isUploading ||
            isDriveImporting
          }
          type="button"
          onClick={() => void onSaveProject()}
        >
          <Save aria-hidden="true" size={17} />
          {isSaving ? 'Enregistrement...' : 'Sauvegarder'}
        </button>
        <p className="studio-publish-hint">
          {isPublished
            ? 'Cette carte est en ligne. Tes modifications seront visibles dès la sauvegarde.'
            : 'Cette carte est en brouillon. Publie-la depuis ton tableau de bord pour la rendre accessible par son lien.'}
        </p>
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
        {saveStatus && saveStatusTone ? (
          <div
            className={`save-status tone-${saveStatusTone}`}
            role={saveStatusTone === 'error' ? 'alert' : 'status'}
            aria-live={saveStatusTone === 'error' ? 'assertive' : 'polite'}
          >
            {saveStatusIcon}
            <span>{saveStatus}</span>
          </div>
        ) : null}
        {importReport ? (
          <ImportReportCard
            report={importReport}
            onDismiss={onDismissReport}
            canEstimatePlacement={canEstimatePlacement}
            onAcceptEstimate={onAcceptEstimatedMedia}
            onEstimateMedia={onEstimateImportedMedia}
            onIgnoreEntry={onIgnoreImportEntry}
            onPlaceMedia={onPlaceImportedMedia}
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

          <button
            className="upload-tile relieo-trace-tile"
            type="button"
            aria-expanded={relioPickerOpen}
            onClick={toggleRelioPicker}
          >
            <Satellite aria-hidden="true" size={22} />
            <span>
              <strong>Importer une trace depuis Relieo</strong>
              <small>
                {relioLoading
                  ? 'Lecture de vos traces...'
                  : 'Vos enregistrements GPS sauvegardes'}
              </small>
            </span>
          </button>

          {relioPickerOpen ? (
            <div className="relieo-trace-picker">
              {relioError ? (
                <p className="relieo-trace-picker-note error">{relioError}</p>
              ) : relioLoading ? (
                <p className="relieo-trace-picker-note">
                  <LoaderCircle aria-hidden="true" size={15} /> Chargement...
                </p>
              ) : relioTraces.length === 0 ? (
                <p className="relieo-trace-picker-note">
                  Aucune trace enregistree. Lance un enregistrement depuis l'onglet
                  Traces.
                </p>
              ) : (
                relioTraces.map((trace) => (
                  <button
                    className="relieo-trace-option"
                    type="button"
                    key={trace.id}
                    onClick={() => {
                      onImportRelioTrace(trace)
                      setRelioPickerOpen(false)
                    }}
                  >
                    <Route aria-hidden="true" size={16} />
                    <span>
                      <strong>{trace.name}</strong>
                      <small>
                        {trace.stats.pointCount.toLocaleString('fr-FR')} points
                      </small>
                    </span>
                    <Plus aria-hidden="true" size={16} />
                  </button>
                ))
              )}
            </div>
          ) : null}

          {traces.length > 0 ? (
            <div className="trace-list">
              {traces.map((trace, index) => {
                const color = trace.color ?? traceColor(index)
                return (
                  <div
                    className={[
                      'trace-item',
                      dragTraceId === trace.id ? 'dragging' : '',
                      dragOverTraceId === trace.id ? 'drag-over' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-trace-id={trace.id}
                    key={trace.id}
                  >
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
                      <button
                        className="trace-drag-handle"
                        type="button"
                        aria-label={`Deplacer ${trace.name}`}
                        title="Glisser pour reordonner"
                        onPointerDown={(event) =>
                          handleTracePointerDown(event, trace.id)
                        }
                        onPointerMove={(event) =>
                          handleTracePointerMove(event, trace.id)
                        }
                        onPointerUp={(event) =>
                          handleTracePointerEnd(event, trace.id)
                        }
                        onPointerCancel={() => {
                          setDragTraceId(null)
                          setDragOverTraceId(null)
                        }}
                        onKeyDown={(event) =>
                          handleTraceHandleKeyDown(event, trace.id, index)
                        }
                      >
                        <GripVertical aria-hidden="true" size={17} />
                      </button>
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

          <button
            className="drive-import-button"
            type="button"
            aria-label="Importer des médias depuis Google Drive"
            disabled={driveImportDisabled}
            title={driveImportHint}
            onClick={() => void onImportDriveMedia()}
          >
            <span className="drive-import-icon" aria-hidden="true">
              <span className="drive-import-mark mark-green" />
              <span className="drive-import-mark mark-yellow" />
              <span className="drive-import-mark mark-blue" />
            </span>
            <span>
              <strong>Google Drive</strong>
              <small>{driveImportHint}</small>
            </span>
          </button>

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

          <div className="cleanup-storage-action">
            <button
              className="secondary-action cleanup-storage-button"
              type="button"
              aria-describedby="cleanup-unused-media-hint"
              title="Supprime de R2 seulement les médias importés qui ne sont utilisés par aucun point."
              disabled={
                !writeAuthReady ||
                !accessCode.trim() ||
                isUploading ||
                isDriveImporting ||
                isCleaningUnusedMedia
              }
              onClick={() => void onCleanupUnusedMedia()}
            >
              <Trash2 aria-hidden="true" size={17} />
              {isCleaningUnusedMedia
                ? 'Suppression...'
                : 'Supprimer les fichiers inutilisés'}
            </button>
            <p id="cleanup-unused-media-hint">
              Retire de R2 uniquement les médias importés qui ne sont plus reliés à
              aucun point.
            </p>
          </div>

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
                <button
                  className="danger-action media-delete-action"
                  type="button"
                  aria-label={`Supprimer ${media.name}`}
                  title="Supprimer ce média du stockage sans supprimer le point"
                  disabled={
                    !writeAuthReady ||
                    !accessCode.trim() ||
                    isUploading ||
                    isDriveImporting ||
                    isCleaningUnusedMedia ||
                    Boolean(deletingMediaId)
                  }
                  onClick={() => void onDeleteMedia(media.id)}
                >
                  {deletingMediaId === media.id ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="save-status-spinner"
                      size={15}
                    />
                  ) : (
                    <Trash2 aria-hidden="true" size={15} />
                  )}
                </button>
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
