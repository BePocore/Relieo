import { useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Eye,
  EyeOff,
  Globe,
  GripVertical,
  Play,
  RotateCcw,
  Video,
  X,
} from 'lucide-react'
import type {
  ImportedMedia,
  SlideshowMediaSettings,
  SlideshowSettings,
  TrailPoint,
} from '../types'
import type { DayPlan } from '../lib/days'
import { resolvePointMedia } from '../lib/media'
import {
  ALL_MEDIA_ORDER_KEY,
  END_CARD_DEFAULT_TITLE,
  MEDIA_DURATION_CHOICES_MS,
  SLIDESHOW_BREAK_MS,
  SLIDESHOW_PHOTO_MS,
  UNDATED_DAY_KEY,
  UNDATED_DEFAULT_INTRO,
  UNDATED_DEFAULT_LABEL,
  applyMediaOrder,
  cleanSlideshowSettings,
  defaultDayIntro,
} from '../lib/slideshow'

// ---------------------------------------------------------------------------
// Éditeur du diaporama (Studio uniquement) : une timeline verticale des
// journées avec leurs médias dans l'ordre de lecture. L'ordre suit le parcours
// et les jours par défaut, mais chaque média est réordonnable DANS SA JOURNÉE
// (glisser-déposer à la souris + flèches ◀▶ tactiles/clavier) ; « Ordre auto »
// remet la journée dans l'ordre du tracé. On y personnalise aussi les cartes de
// transition (titre + intro), les durées (globales et par média), les médias
// masqués et la carte de fin. Chaque modification remonte immédiatement à App
// (état + autosave), la timeline n'a pas de bouton « Enregistrer ».
// ---------------------------------------------------------------------------

type SlideshowEditorProps = {
  dayPlan: DayPlan
  points: TrailPoint[]
  // Médias en ordre chronologique par jour (même source que le diaporama).
  mediaPoints: TrailPoint[]
  mediaLibrary: ImportedMedia[]
  settings?: SlideshowSettings
  onChange: (next: SlideshowSettings | undefined) => void
  onPreview: () => void
  canPreview: boolean
  onClose: () => void
}

type EditorSection = {
  // Clé du Record `days` ('YYYY-MM-DD' ou 'undated') ; null = carte d'un seul
  // jour, sans carte de transition (rien à personnaliser côté jour).
  key: string | null
  color: string
  defaultLabel: string
  defaultIntro: string
  dateLabel: string
  media: TrailPoint[]
}

// État d'un glisser-déposer en cours (une seule section à la fois).
type DragState = {
  sectionKey: string
  draggingId: string
  ids: string[] // ordre live pendant le glissement
  origin: string[] // ordre au début du drag (pour ne rien émettre si inchangé)
  naturalIds: string[] // ordre automatique de la section (pour « ordre auto »)
}

const formatSeconds = (ms: number): string =>
  `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`

// Clé de section pour le Record `order` : une carte d'un seul jour n'a pas de
// clé de jour → clé réservée 'all'.
const sectionKeyOf = (key: string | null): string => key ?? ALL_MEDIA_ORDER_KEY

const idsOf = (media: TrailPoint[]): string[] =>
  media
    .map((point) => point.id ?? '')
    .filter((id): id is string => id.length > 0)

const sameOrder = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index])

export function SlideshowEditor({
  dayPlan,
  points,
  mediaPoints,
  mediaLibrary,
  settings,
  onChange,
  onPreview,
  canPreview,
  onClose,
}: SlideshowEditorProps) {
  const current: SlideshowSettings = settings ?? {}
  const [drag, setDrag] = useState<DragState | null>(null)

  // Une section par carte de transition (+ « Non datés »), ou une section
  // unique à plat pour une carte d'un seul jour. Les médias restent ici dans
  // l'ordre AUTOMATIQUE (le long du tracé) ; l'ordre custom est appliqué au
  // rendu, pour pouvoir comparer et proposer « Ordre auto ».
  const sections = useMemo<EditorSection[]>(() => {
    const dayKeyByPoint = new Map<TrailPoint, string | null>()
    points.forEach((point, index) => {
      dayKeyByPoint.set(point, dayPlan.pointDayKeys[index] ?? null)
    })
    if (!dayPlan.multiDay) {
      return [
        {
          key: null,
          color: '#4fd1a1',
          defaultLabel: 'Tous les médias',
          defaultIntro: '',
          dateLabel: "Dans l'ordre du parcours",
          media: mediaPoints,
        },
      ]
    }
    const result: EditorSection[] = dayPlan.days.map((day, index) => ({
      key: day.key,
      color: day.color,
      defaultLabel: day.label,
      defaultIntro: defaultDayIntro(index),
      dateLabel: day.dateLabel,
      media: mediaPoints.filter((point) => dayKeyByPoint.get(point) === day.key),
    }))
    const undated = mediaPoints.filter(
      (point) => (dayKeyByPoint.get(point) ?? null) === null,
    )
    if (undated.length > 0) {
      result.push({
        key: UNDATED_DAY_KEY,
        color: '#93a1b5',
        defaultLabel: UNDATED_DEFAULT_LABEL,
        defaultIntro: UNDATED_DEFAULT_INTRO,
        dateLabel: 'Sans date',
        media: undated,
      })
    }
    return result
  }, [dayPlan, points, mediaPoints])

  const emit = (next: SlideshowSettings) => onChange(cleanSlideshowSettings(next))

  const setDayField = (
    dayKey: string,
    field: 'title' | 'intro',
    value: string,
  ) => {
    const days = { ...(current.days ?? {}) }
    const entry = { ...(days[dayKey] ?? {}) }
    if (value) entry[field] = value
    else delete entry[field]
    if (Object.keys(entry).length === 0) delete days[dayKey]
    else days[dayKey] = entry
    emit({ ...current, days })
  }

  const setMediaField = (
    pointId: string,
    patch: Partial<SlideshowMediaSettings>,
  ) => {
    if (!pointId) return
    const media = { ...(current.media ?? {}) }
    const entry = { ...(media[pointId] ?? {}), ...patch }
    if (!entry.durationMs) delete entry.durationMs
    if (!entry.excluded) delete entry.excluded
    if (Object.keys(entry).length === 0) delete media[pointId]
    else media[pointId] = entry
    emit({ ...current, media })
  }

  const setEndCard = (patch: { enabled?: boolean; title?: string }) => {
    emit({ ...current, endCard: { ...(current.endCard ?? {}), ...patch } })
  }

  // Persiste l'ordre d'une section (ou l'efface s'il retrouve l'ordre auto).
  const commitOrder = (
    sectionKey: string,
    naturalIds: string[],
    nextIds: string[],
  ) => {
    const order = { ...(current.order ?? {}) }
    if (sameOrder(nextIds, naturalIds)) delete order[sectionKey]
    else order[sectionKey] = nextIds
    emit({ ...current, order })
  }

  const resetOrder = (sectionKey: string) => {
    if (!current.order?.[sectionKey]) return
    const order = { ...current.order }
    delete order[sectionKey]
    emit({ ...current, order })
  }

  // Flèches ◀▶ : échange deux médias voisins dans l'ordre affiché.
  const moveMedia = (
    sectionKey: string,
    naturalIds: string[],
    displayedIds: string[],
    index: number,
    dir: -1 | 1,
  ) => {
    const target = index + dir
    if (target < 0 || target >= displayedIds.length) return
    const next = [...displayedIds]
    ;[next[index], next[target]] = [next[target], next[index]]
    commitOrder(sectionKey, naturalIds, next)
  }

  const startDrag = (
    sectionKey: string,
    displayedIds: string[],
    naturalIds: string[],
    draggingId: string,
  ) => {
    setDrag({
      sectionKey,
      draggingId,
      ids: displayedIds,
      origin: displayedIds,
      naturalIds,
    })
  }

  // Réordonne en direct : place le média glissé à l'emplacement du média survolé.
  const dragOver = (sectionKey: string, overId: string) => {
    setDrag((prev) => {
      if (!prev || prev.sectionKey !== sectionKey || overId === prev.draggingId) {
        return prev
      }
      const from = prev.ids.indexOf(prev.draggingId)
      const to = prev.ids.indexOf(overId)
      if (from < 0 || to < 0 || from === to) return prev
      const ids = [...prev.ids]
      ids.splice(from, 1)
      ids.splice(to, 0, prev.draggingId)
      return { ...prev, ids }
    })
  }

  const endDrag = () => {
    if (!drag) return
    if (!sameOrder(drag.ids, drag.origin)) {
      commitOrder(drag.sectionKey, drag.naturalIds, drag.ids)
    }
    setDrag(null)
  }

  const photoMs = current.photoMs ?? SLIDESHOW_PHOTO_MS
  const breakMs = current.breakMs ?? SLIDESHOW_BREAK_MS
  const endEnabled = current.endCard?.enabled ?? dayPlan.multiDay

  const renderMediaCard = (
    point: TrailPoint,
    index: number,
    ctx: {
      sectionKey: string
      displayedIds: string[]
      naturalIds: string[]
      canReorder: boolean
    },
  ) => {
    const media = resolvePointMedia(point, mediaLibrary)
    // `normalizePoint` garantit un id au chargement ; sans id (cas limite),
    // le média apparaît dans la timeline mais n'est ni personnalisable ni
    // réordonnable.
    const pointId = point.id ?? ''
    const entry = pointId ? current.media?.[pointId] : undefined
    const excluded = Boolean(entry?.excluded)
    const isVideo = media?.kind === 'video'
    const isImage = media?.kind === 'image'
    const canDrag = ctx.canReorder && Boolean(pointId)
    const isDragging = drag?.draggingId === pointId && Boolean(pointId)
    const classes = ['se-media']
    if (excluded) classes.push('excluded')
    if (isDragging) classes.push('dragging')
    return (
      <div
        className={classes.join(' ')}
        key={pointId || `media-${index}`}
        onDragEnter={() => {
          if (drag && pointId) dragOver(ctx.sectionKey, pointId)
        }}
        onDragOver={(event) => {
          if (drag?.sectionKey === ctx.sectionKey) event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          endDrag()
        }}
      >
        <div className="se-media-thumb">
          {isImage && media ? (
            <img
              src={media.thumbnailSrc ?? media.src}
              alt=""
              decoding="async"
              loading="lazy"
              fetchPriority="low"
            />
          ) : (
            <span className="se-media-icon">
              {isVideo ? (
                <Video aria-hidden="true" size={18} />
              ) : (
                <Globe aria-hidden="true" size={18} />
              )}
            </span>
          )}
          <span className="se-media-order">{index + 1}</span>
          {excluded ? <span className="se-media-hidden-tag">Masqué</span> : null}
        </div>
        <p className="se-media-title" title={point.title}>
          {point.title}
        </p>
        <div className="se-media-controls">
          {isVideo ? (
            <span className="se-media-video-note">Jouée en entier</span>
          ) : (
            <select
              aria-label={`Durée d'affichage de « ${point.title} »`}
              value={String(entry?.durationMs ?? '')}
              disabled={!pointId}
              onChange={(event) =>
                setMediaField(pointId, {
                  durationMs: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
            >
              <option value="">Durée auto</option>
              {MEDIA_DURATION_CHOICES_MS.map((ms) => (
                <option key={ms} value={ms}>
                  {formatSeconds(ms)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="se-media-eye"
            aria-label={
              excluded
                ? 'Réafficher ce média dans le diaporama'
                : 'Masquer ce média du diaporama'
            }
            title={
              excluded
                ? 'Réafficher dans le diaporama'
                : 'Masquer du diaporama (le média reste sur la carte)'
            }
            disabled={!pointId}
            onClick={() => setMediaField(pointId, { excluded: !excluded })}
          >
            {excluded ? (
              <EyeOff aria-hidden="true" size={16} />
            ) : (
              <Eye aria-hidden="true" size={16} />
            )}
          </button>
        </div>
        {ctx.canReorder ? (
          <div className="se-media-reorder">
            <button
              type="button"
              className="se-media-move"
              aria-label={`Déplacer « ${point.title} » vers la gauche`}
              title="Déplacer vers la gauche"
              disabled={!pointId || index === 0}
              onClick={() =>
                moveMedia(
                  ctx.sectionKey,
                  ctx.naturalIds,
                  ctx.displayedIds,
                  index,
                  -1,
                )
              }
            >
              <ChevronLeft aria-hidden="true" size={15} />
            </button>
            <span
              className="se-media-grip"
              role="button"
              aria-label={`Glisser « ${point.title} » pour le réordonner`}
              title="Glisser pour réordonner"
              draggable={canDrag}
              onDragStart={(event) => {
                if (!canDrag) return
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', pointId)
                const card = (event.currentTarget as HTMLElement).closest(
                  '.se-media',
                ) as HTMLElement | null
                if (card) {
                  event.dataTransfer.setDragImage(card, card.clientWidth / 2, 24)
                }
                startDrag(
                  ctx.sectionKey,
                  ctx.displayedIds,
                  ctx.naturalIds,
                  pointId,
                )
              }}
              onDragEnd={endDrag}
            >
              <GripVertical aria-hidden="true" size={15} />
            </span>
            <button
              type="button"
              className="se-media-move"
              aria-label={`Déplacer « ${point.title} » vers la droite`}
              title="Déplacer vers la droite"
              disabled={!pointId || index === ctx.displayedIds.length - 1}
              onClick={() =>
                moveMedia(
                  ctx.sectionKey,
                  ctx.naturalIds,
                  ctx.displayedIds,
                  index,
                  1,
                )
              }
            >
              <ChevronRight aria-hidden="true" size={15} />
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="slideshow-editor"
      role="dialog"
      aria-modal="true"
      aria-label="Réglages du diaporama"
    >
      <header className="se-head">
        <span className="se-head-icon">
          <Clapperboard aria-hidden="true" size={20} />
        </span>
        <div className="se-head-titles">
          <h2>Diaporama</h2>
          <p>
            Réordonne les médias dans chaque journée (glisse-les ou utilise les
            flèches), personnalise les cartes, les durées et les médias affichés.
          </p>
        </div>
        <div className="se-actions">
          <button
            type="button"
            className="se-btn primary"
            onClick={onPreview}
            disabled={!canPreview}
          >
            <Play aria-hidden="true" size={16} />
            <span>Prévisualiser</span>
          </button>
          <button type="button" className="se-btn" onClick={onClose}>
            <X aria-hidden="true" size={16} />
            <span>Fermer</span>
          </button>
        </div>
      </header>

      <div className="se-globals">
        <label className="se-global">
          <span className="se-global-label">
            Durée des photos · <b>{formatSeconds(photoMs)}</b>
          </span>
          <input
            type="range"
            min={2}
            max={10}
            step={0.5}
            value={photoMs / 1000}
            aria-label="Durée d'affichage des photos"
            onChange={(event) =>
              emit({
                ...current,
                photoMs: Math.round(Number(event.target.value) * 1000),
              })
            }
          />
          {current.photoMs !== undefined ? (
            <button
              type="button"
              className="se-reset"
              onClick={() => emit({ ...current, photoMs: undefined })}
            >
              Par défaut
            </button>
          ) : null}
        </label>
        <label className="se-global">
          <span className="se-global-label">
            Cartes de jour · <b>{formatSeconds(breakMs)}</b>
          </span>
          <input
            type="range"
            min={1.5}
            max={6}
            step={0.5}
            value={breakMs / 1000}
            aria-label="Durée d'affichage des cartes de jour"
            onChange={(event) =>
              emit({
                ...current,
                breakMs: Math.round(Number(event.target.value) * 1000),
              })
            }
          />
          {current.breakMs !== undefined ? (
            <button
              type="button"
              className="se-reset"
              onClick={() => emit({ ...current, breakMs: undefined })}
            >
              Par défaut
            </button>
          ) : null}
        </label>
        <p className="se-globals-note">Les vidéos jouent toujours en entier.</p>
      </div>

      <div className="se-body">
        {sections.map((section) => {
          const dayKey = section.key
          const daySetting = dayKey ? current.days?.[dayKey] : undefined
          const orderKey = sectionKeyOf(section.key)
          const activeIds =
            drag?.sectionKey === orderKey ? drag.ids : current.order?.[orderKey]
          const displayed = applyMediaOrder(section.media, activeIds)
          const displayedIds = idsOf(displayed)
          const naturalIds = idsOf(section.media)
          const canReorder = section.media.length > 1
          const isCustomOrder = Boolean(current.order?.[orderKey])
          const hiddenCount = section.media.filter((point) =>
            Boolean(point.id && current.media?.[point.id]?.excluded),
          ).length
          return (
            <section
              className="se-day"
              key={dayKey ?? 'single'}
              style={{ ['--day' as string]: section.color }}
            >
              <header className="se-day-head">
                <span className="se-day-dot" aria-hidden="true" />
                {dayKey ? (
                  <div className="se-day-fields">
                    <input
                      className="se-day-title"
                      type="text"
                      value={daySetting?.title ?? ''}
                      placeholder={section.defaultLabel}
                      maxLength={60}
                      aria-label={`Titre de la carte « ${section.defaultLabel} »`}
                      onChange={(event) =>
                        setDayField(dayKey, 'title', event.target.value)
                      }
                    />
                    <input
                      className="se-day-intro"
                      type="text"
                      value={daySetting?.intro ?? ''}
                      placeholder={section.defaultIntro}
                      maxLength={80}
                      aria-label={`Phrase d'introduction de « ${section.defaultLabel} »`}
                      onChange={(event) =>
                        setDayField(dayKey, 'intro', event.target.value)
                      }
                    />
                  </div>
                ) : (
                  <div className="se-day-fields">
                    <p className="se-day-static">{section.defaultLabel}</p>
                  </div>
                )}
                <span className="se-day-meta">
                  {section.dateLabel} · {section.media.length} média
                  {section.media.length > 1 ? 's' : ''}
                  {hiddenCount > 0
                    ? ` · ${hiddenCount} masqué${hiddenCount > 1 ? 's' : ''}`
                    : ''}
                </span>
                {isCustomOrder ? (
                  <button
                    type="button"
                    className="se-order-reset"
                    title="Remettre les médias dans l'ordre du parcours"
                    onClick={() => resetOrder(orderKey)}
                  >
                    <RotateCcw aria-hidden="true" size={13} />
                    <span>Ordre auto</span>
                  </button>
                ) : null}
              </header>
              {displayed.length > 0 ? (
                <div className="se-media-strip">
                  {displayed.map((point, index) =>
                    renderMediaCard(point, index, {
                      sectionKey: orderKey,
                      displayedIds,
                      naturalIds,
                      canReorder,
                    }),
                  )}
                </div>
              ) : (
                <p className="se-day-empty">
                  Aucun média ce jour-là (la carte de transition s'affichera
                  quand même).
                </p>
              )}
            </section>
          )
        })}

        <section
          className="se-day se-endcard"
          style={{ ['--day' as string]: '#4fd1a1' }}
        >
          <header className="se-day-head">
            <span className="se-day-dot" aria-hidden="true" />
            <div className="se-day-fields">
              <label className="se-end-toggle">
                <input
                  type="checkbox"
                  checked={endEnabled}
                  onChange={(event) =>
                    setEndCard({ enabled: event.target.checked })
                  }
                />
                <span>
                  Carte de fin (titre + stats totales du voyage, ajoutée en
                  dernière slide)
                </span>
              </label>
              {endEnabled ? (
                <input
                  className="se-day-title"
                  type="text"
                  value={current.endCard?.title ?? ''}
                  placeholder={END_CARD_DEFAULT_TITLE}
                  maxLength={60}
                  aria-label="Titre de la carte de fin"
                  onChange={(event) =>
                    setEndCard({ title: event.target.value || undefined })
                  }
                />
              ) : null}
            </div>
          </header>
        </section>
      </div>
    </div>
  )
}
