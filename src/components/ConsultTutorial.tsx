// Tuto de bienvenue « projecteur » du mode CONSULTATION (visiteur anonyme, web).
//
// Un overlay assombrit la carte et perce un trou lumineux sur l'élément
// expliqué, étape par étape (bulle + Suivant). Il n'apprend que la navigation
// de consultation (relief 3D, fond de carte, médias, diaporama, parcours), donc
// aucun serveur : la mémoire « déjà vu récemment » vit en localStorage
// (cf. src/lib/consultTutorial.ts). Les étapes dont la cible est absente sur la
// carte courante (vue verrouillée, pas de média, expo photos…) sont sautées.
//
// Pendant sur mobile : les contrôles ciblés existent toujours (juste réduits),
// et le panneau reste fermé (sinon le CSS `panel-open` masque ces contrôles).

import {
  Check,
  Hand,
  Images,
  Layers,
  List,
  MapPinned,
  Mountain,
  Play,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  dismissConsultTutorialForever,
  markConsultTutorialSeen,
  sendConsultTutorialEvent,
  shouldShowConsultTutorial,
  type ConsultTutorialStepKey,
} from '../lib/consultTutorial'

type ConsultTutorialProps = {
  /** Carte chargée, visible, en consultation : le tuto peut se lancer. */
  active: boolean
  /** Des médias sont posés sur la carte → étape « médias ». */
  hasMedia: boolean
  /** Le diaporama est disponible → étape « diaporama ». */
  hasSlideshow: boolean
  /** Vue verrouillée en 2D (pas de relief) → texte adapté. */
  flat2D: boolean
  /** Séjour multi-jours → texte « parcours » adapté. */
  multiDay: boolean
  /** Carte de type exposition photos (sans traces) → texte adapté. */
  gallery: boolean
}

type Box = { left: number; top: number; width: number; height: number }

type Step = {
  /** Clé typée : elle est remontée telle quelle à la mesure. */
  key: ConsultTutorialStepKey
  /** Sélecteurs CSS de la cible (le 1er trouvé gagne) ; null = carte centrée. */
  selectors: string[] | null
  Icon: LucideIcon
  title: string
  text: string
  /**
   * Cible manipulable pendant l'étape : le trou laisse passer les clics, on
   * apprend en essayant. Réservé aux contrôles à effet immédiat (relief, fond
   * de carte) ; interdit à ceux qui ouvrent quelque chose PAR-DESSUS le tuto
   * (médias et diaporama ouvrent la lightbox, parcours ouvre le panneau).
   */
  interactive?: boolean
  /** Invitation à manipuler, affichée sous le texte des étapes interactives. */
  hint?: string
}

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), Math.max(min, max))

const HOLE_PAD = 8
const HOLE_RADIUS = 14
/** Délai avant le démarrage : laisse la caméra se poser et les pastilles monter. */
const START_DELAY_MS = 900

function buildSteps({
  hasMedia,
  hasSlideshow,
  flat2D,
  multiDay,
  gallery,
}: Omit<ConsultTutorialProps, 'active'>): Step[] {
  const steps: Step[] = []

  steps.push({
    key: 'welcome',
    selectors: null,
    Icon: Sparkles,
    title: 'Bienvenue !',
    text: "Cette carte se visite en relief. Deux secondes pour voir comment l'explorer.",
  })

  steps.push({
    key: 'relief',
    selectors: ['.map-view-controls'],
    Icon: flat2D ? MapPinned : Mountain,
    title: flat2D ? 'Se déplacer sur la carte' : 'Le relief en 3D',
    text: flat2D
      ? 'Fais pivoter, zoome et recadre la vue avec ces boutons (ou directement à deux doigts sur la carte).'
      : 'Incline la vue pour révéler le relief, fais-la pivoter et zoome avec ces boutons (ou à deux doigts sur la carte).',
    interactive: true,
    hint: flat2D
      ? 'Essaie : ces boutons marchent tout de suite.'
      : 'Essaie : incline la vue, le relief apparaît.',
  })

  steps.push({
    key: 'basemap',
    selectors: ['.basemap-control'],
    Icon: Layers,
    title: 'Changer de fond',
    text: 'Passe de la vue satellite au fond topographique ou carte, selon ce que tu veux voir.',
    interactive: true,
    hint: 'Essaie : la carte change aussitôt.',
  })

  if (hasMedia) {
    steps.push({
      key: 'media',
      selectors: ['.maplibre-photo-marker', '.media-rail'],
      Icon: Images,
      title: 'Les photos et vidéos',
      text: "Chaque média est posé à son endroit exact. Clique une pastille sur la carte (ou une vignette en bas) pour l'ouvrir en grand.",
    })
  }

  if (hasSlideshow) {
    steps.push({
      key: 'slideshow',
      selectors: ['[data-tuto="slideshow"]'],
      Icon: Play,
      title: 'Le diaporama',
      text: 'Lance la lecture enchaînée de tous les médias, dans l’ordre du parcours.',
    })
  }

  steps.push({
    key: 'parcours',
    selectors: ['[data-tuto="parcours"]'],
    Icon: List,
    title: 'Le parcours en détail',
    text: gallery
      ? 'Ouvre le panneau : la liste des photos et des lieux de cette carte.'
      : multiDay
        ? "Ouvre le panneau : distances, dénivelé, profil d'altitude et le détail jour par jour."
        : "Ouvre le panneau : distances, dénivelé, profil d'altitude et les médias.",
  })

  steps.push({
    key: 'end',
    selectors: null,
    Icon: Check,
    title: 'À toi de jouer',
    text: 'Bonne exploration. Ce petit guide ne reviendra pas à ta prochaine visite.',
  })

  return steps
}

/** Chemin SVG : rectangle plein écran + trou arrondi (fill-rule evenodd). */
function overlayPath(w: number, h: number, box: Box | null): string {
  const outer = `M0 0H${w}V${h}H0Z`
  if (!box) return outer
  const x = Math.max(0, box.left - HOLE_PAD)
  const y = Math.max(0, box.top - HOLE_PAD)
  const bw = box.width + HOLE_PAD * 2
  const bh = box.height + HOLE_PAD * 2
  const r = Math.max(0, Math.min(HOLE_RADIUS, bw / 2, bh / 2))
  const inner =
    `M${x + r} ${y}H${x + bw - r}A${r} ${r} 0 0 1 ${x + bw} ${y + r}` +
    `V${y + bh - r}A${r} ${r} 0 0 1 ${x + bw - r} ${y + bh}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + bh - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  return `${outer} ${inner}`
}

export function ConsultTutorial({
  active,
  hasMedia,
  hasSlideshow,
  flat2D,
  multiDay,
  gallery,
}: ConsultTutorialProps) {
  const steps = useMemo(
    () => buildSteps({ hasMedia, hasSlideshow, flat2D, multiDay, gallery }),
    [hasMedia, hasSlideshow, flat2D, multiDay, gallery],
  )

  const [started, setStarted] = useState(false)
  const [done, setDone] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [rect, setRect] = useState<Box | null>(null)
  const [size, setSize] = useState(() => ({
    w: typeof window === 'undefined' ? 0 : window.innerWidth,
    h: typeof window === 'undefined' ? 0 : window.innerHeight,
  }))
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const bubbleRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<Box | null>(null)

  const idx = Math.min(stepIndex, steps.length - 1)
  const step = steps[idx]

  // Démarrage : une seule fois, quand la carte est prête et si le navigateur
  // n'a pas déjà vu le guide récemment (ou opté pour « ne plus afficher »).
  useEffect(() => {
    if (started || done || !active || steps.length === 0) return
    // Pas de mémoire à afficher : on ne démarre simplement pas (rendu null).
    if (!shouldShowConsultTutorial()) return
    const first = steps[0]?.key ?? 'welcome'
    const t = window.setTimeout(() => {
      setStarted(true)
      sendConsultTutorialEvent('start', first)
    }, START_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [active, started, done, steps])

  // Mesure de la cible courante (sélecteurs → rect), sans re-render inutile.
  const measure = useCallback(() => {
    const current = steps[Math.min(stepIndex, steps.length - 1)]
    let box: Box | null = null
    if (current?.selectors) {
      for (const sel of current.selectors) {
        const el = document.querySelector(sel) as HTMLElement | null
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (r.width > 4 && r.height > 4) {
          box = { left: r.left, top: r.top, width: r.width, height: r.height }
          break
        }
      }
    }
    const prev = rectRef.current
    const same =
      (!box && !prev) ||
      (!!box &&
        !!prev &&
        Math.abs(box.left - prev.left) < 0.5 &&
        Math.abs(box.top - prev.top) < 0.5 &&
        Math.abs(box.width - prev.width) < 0.5 &&
        Math.abs(box.height - prev.height) < 0.5)
    if (!same) {
      rectRef.current = box
      setRect(box)
    }
  }, [steps, stepIndex])

  // Pendant le tour : suivi de la cible (elle peut monter tard) + resize.
  useEffect(() => {
    if (!started || done) return
    measure()
    const id = window.setInterval(measure, 250)
    const onResize = () => {
      setSize({ w: window.innerWidth, h: window.innerHeight })
      measure()
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('resize', onResize)
    }
  }, [started, done, measure])

  // Placement de la bulle : sous la cible si la place le permet, sinon dessus,
  // sinon sur le côté ; centrée quand il n'y a pas de cible.
  useLayoutEffect(() => {
    if (!started || done) return
    const el = bubbleRef.current
    if (!el) return
    // Sans cible : bulle centrée (via la classe is-centered au rendu), rien à
    // calculer ici (on évite un setState constant dans l'effet).
    if (!rect) return
    const gap = 14
    const bw = el.offsetWidth
    const bh = el.offsetHeight
    const cx = rect.left + rect.width / 2
    let left = clamp(cx - bw / 2, 12, size.w - bw - 12)
    let top: number
    if (rect.top + rect.height + gap + bh <= size.h - 12) {
      top = rect.top + rect.height + gap
    } else if (rect.top - gap - bh >= 12) {
      top = rect.top - gap - bh
    } else {
      top = clamp(size.h / 2 - bh / 2, 12, size.h - bh - 12)
      const spaceRight = size.w - (rect.left + rect.width)
      left =
        rect.left >= spaceRight
          ? clamp(rect.left - gap - bw, 12, size.w - bw - 12)
          : clamp(rect.left + rect.width + gap, 12, size.w - bw - 12)
    }
    setPos({ left, top })
  }, [rect, stepIndex, size, started, done])

  /** Étape en cours, pour dire à la mesure OÙ le visiteur s'est arrêté. */
  const currentKey = useCallback(
    (): ConsultTutorialStepKey =>
      steps[Math.min(stepIndex, steps.length - 1)]?.key ?? 'welcome',
    [steps, stepIndex],
  )

  /** « Passer » (croix ou Échap) : re-propose après la fenêtre de silence. */
  const finishSeen = useCallback(() => {
    sendConsultTutorialEvent('skip', currentKey())
    markConsultTutorialSeen()
    setDone(true)
  }, [currentKey])

  /** « Terminer » : le visiteur est allé au bout. */
  const complete = useCallback(() => {
    sendConsultTutorialEvent('done', 'end')
    markConsultTutorialSeen()
    setDone(true)
  }, [])

  // La fin se décide ICI et pas dans l'updater de setStepIndex : React
  // double-appelle les updaters en StrictMode, ce qui enverrait la mesure
  // deux fois.
  const next = useCallback(() => {
    if (stepIndex >= steps.length - 1) {
      complete()
      return
    }
    setStepIndex(stepIndex + 1)
  }, [stepIndex, steps.length, complete])

  const never = useCallback(() => {
    sendConsultTutorialEvent('never', currentKey())
    dismissConsultTutorialForever()
    setDone(true)
  }, [currentKey])

  // Onglet fermé pendant le tour : on distingue « il est parti » de « il a
  // cliqué Passer », sinon l'abandon serait un trou noir dans la mesure.
  useEffect(() => {
    if (!started || done) return
    const onHide = () => sendConsultTutorialEvent('abandon', currentKey())
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [started, done, currentKey])

  // Clavier : Échap = passer, → = suivant. (Pas Entrée : sur une étape
  // interactive, un bouton de la carte gardant le focus déclencherait à la fois
  // son action et le passage à l'étape suivante.)
  useEffect(() => {
    if (!started || done) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finishSeen()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [started, done, next, finishSeen])

  if (!started || done || !step) return null

  const isLast = idx >= steps.length - 1
  const holeX = rect ? Math.max(0, rect.left - HOLE_PAD) : 0
  const holeY = rect ? Math.max(0, rect.top - HOLE_PAD) : 0
  const holeW = rect ? rect.width + HOLE_PAD * 2 : 0
  const holeH = rect ? rect.height + HOLE_PAD * 2 : 0
  const holeR = Math.max(0, Math.min(HOLE_RADIUS, holeW / 2, holeH / 2))
  const Icon = step.Icon

  return (
    <div
      className="consult-tuto"
      role="dialog"
      aria-modal="true"
      aria-label="Guide de découverte de la carte"
    >
      <svg
        className="consult-tuto-scrim"
        width={size.w}
        height={size.h}
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {/* Seul le tracé capte les clics : son trou (fill-rule evenodd) les
            laisse passer vers la cible. */}
        <path d={overlayPath(size.w, size.h, rect)} fillRule="evenodd" />
        {rect ? (
          <rect
            className={
              step.interactive
                ? 'consult-tuto-ring is-live'
                : 'consult-tuto-ring'
            }
            x={holeX}
            y={holeY}
            width={holeW}
            height={holeH}
            rx={holeR}
          />
        ) : null}
        {/* Étape non interactive : on rebouche le trou côté clics. */}
        {rect && !step.interactive ? (
          <rect
            className="consult-tuto-block"
            x={holeX}
            y={holeY}
            width={holeW}
            height={holeH}
            rx={holeR}
          />
        ) : null}
      </svg>

      <div
        ref={bubbleRef}
        className={rect ? 'consult-tuto-bubble' : 'consult-tuto-bubble is-centered'}
        style={rect && pos ? { left: pos.left, top: pos.top } : undefined}
      >
        <button
          className="consult-tuto-close"
          type="button"
          aria-label="Passer le guide"
          title="Passer"
          onClick={finishSeen}
        >
          <X aria-hidden="true" size={15} />
        </button>

        <div className="consult-tuto-head">
          <span className="consult-tuto-icon">
            <Icon aria-hidden="true" size={18} />
          </span>
          <h2 className="consult-tuto-title">{step.title}</h2>
        </div>
        <p className="consult-tuto-text">{step.text}</p>
        {step.hint ? (
          <p className="consult-tuto-hint">
            <Hand aria-hidden="true" size={13} />
            <span>{step.hint}</span>
          </p>
        ) : null}

        <div className="consult-tuto-foot">
          <button className="consult-tuto-never" type="button" onClick={never}>
            Ne plus afficher
          </button>
          <div className="consult-tuto-foot-right">
            <span className="consult-tuto-count">
              {idx + 1} / {steps.length}
            </span>
            <button className="consult-tuto-next" type="button" onClick={next}>
              {isLast ? 'Terminer' : 'Suivant'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
