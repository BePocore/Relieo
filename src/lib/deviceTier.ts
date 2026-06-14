// Détection (forcément imparfaite, surtout sur iOS) du palier de performance de
// l'appareil, pour basculer en mode 2D allégé sur les machines trop faibles.
// Pensé pour se réutiliser tel quel lors d'une future migration de moteur carte.

export type PerfTier = 'low' | 'high'

const readGpuRenderer = (): string => {
  try {
    const canvas = document.createElement('canvas')
    const gl =
      (canvas.getContext('webgl') as WebGLRenderingContext | null) ??
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null)
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (!ext) return ''
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    return typeof renderer === 'string' ? renderer : ''
  } catch {
    return ''
  }
}

// GPU mobiles clairement faibles / anciens (quand le nom est exposé).
const weakGpuPattern =
  /(PowerVR|Mali-[34]\d{2}|Mali-G3|Adreno \(TM\) [1-4]\d{2}|Apple A[789]\b|Apple A10\b|Apple A11\b)/i

// Estimation rapide au démarrage. Par défaut « high » si on ne sait pas : on ne
// dégrade pas à tort un appareil correct ; le watchdog FPS rattrape les ratés.
export const getInitialPerfTier = (): PerfTier => {
  const nav = navigator as Navigator & { deviceMemory?: number }
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory < 4) {
    return 'low'
  }
  if (
    typeof navigator.hardwareConcurrency === 'number' &&
    navigator.hardwareConcurrency > 0 &&
    navigator.hardwareConcurrency <= 2
  ) {
    return 'low'
  }
  const gpu = readGpuRenderer()
  if (gpu && weakGpuPattern.test(gpu)) return 'low'
  return 'high'
}

type FpsWatchdogOptions = {
  // On compte les images « longues » (jank réel) hors warmup et hors arrière-plan.
  longFrameMs?: number
  // Au-delà : c'est probablement un onglet en pause, pas du jank → ignoré.
  maxFrameMs?: number
  neededLongFrames?: number
  warmupMs?: number
  observeMs?: number
}

// Surveille le rendu : si l'appareil « rame » (beaucoup d'images longues d'affilée
// pendant la fenêtre d'observation), appelle onLowPerf UNE fois. Ne fait jamais
// l'inverse (pas d'upgrade auto → pas de va-et-vient). Renvoie un stop().
export const createFpsWatchdog = (
  onLowPerf: () => void,
  options: FpsWatchdogOptions = {},
): { stop: () => void } => {
  const longFrameMs = options.longFrameMs ?? 55
  const maxFrameMs = options.maxFrameMs ?? 300
  const neededLongFrames = options.neededLongFrames ?? 14
  const warmupMs = options.warmupMs ?? 1000
  const observeMs = options.observeMs ?? 12000

  let raf = 0
  let stopped = false
  let longFrames = 0
  const start = performance.now()
  let last = start

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
  }

  const tick = (now: number) => {
    if (stopped) return
    const delta = now - last
    last = now

    if (
      now - start > warmupMs &&
      !document.hidden &&
      delta > longFrameMs &&
      delta < maxFrameMs
    ) {
      longFrames += 1
      if (longFrames >= neededLongFrames) {
        stop()
        onLowPerf()
        return
      }
    }

    if (now - start > observeMs) {
      stop()
      return
    }
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)
  return { stop }
}
