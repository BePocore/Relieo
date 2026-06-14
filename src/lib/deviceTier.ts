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
  warmupMs?: number
  windowMs?: number
  minFps?: number
  neededBadWindows?: number
  observeMs?: number
}

// Surveille le framerate moyen par fenêtres glissantes. Ne déclasse QUE si le
// framerate est mauvais sur plusieurs fenêtres CONSÉCUTIVES (jank soutenu, pas
// un simple pic de chargement) — sinon des appareils corrects basculeraient à
// tort. Jamais d'upgrade auto (pas de va-et-vient). Renvoie un stop().
export const createFpsWatchdog = (
  onLowPerf: () => void,
  options: FpsWatchdogOptions = {},
): { stop: () => void } => {
  // Temps de chauffe long : on ignore le pic de rendu du chargement initial.
  const warmupMs = options.warmupMs ?? 3500
  const windowMs = options.windowMs ?? 2000
  const minFps = options.minFps ?? 22
  // 3 fenêtres de 2 s = ~6 s de jank continu avant de déclasser.
  const neededBadWindows = options.neededBadWindows ?? 3
  const observeMs = options.observeMs ?? 30000

  let raf = 0
  let stopped = false
  let warmed = false
  let windowStart = 0
  let frames = 0
  let badWindows = 0
  const start = performance.now()

  const stop = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(raf)
  }

  const tick = (now: number) => {
    if (stopped) return

    if (!warmed) {
      if (now - start >= warmupMs) {
        warmed = true
        windowStart = now
        frames = 0
      }
      raf = requestAnimationFrame(tick)
      return
    }

    if (now - start > observeMs) {
      stop()
      return
    }

    // Onglet en arrière-plan : non représentatif, on réinitialise la fenêtre.
    if (document.hidden) {
      windowStart = now
      frames = 0
      raf = requestAnimationFrame(tick)
      return
    }

    frames += 1
    const elapsed = now - windowStart
    if (elapsed >= windowMs) {
      const fps = (frames * 1000) / elapsed
      if (fps < minFps) {
        badWindows += 1
        if (badWindows >= neededBadWindows) {
          stop()
          onLowPerf()
          return
        }
      } else {
        badWindows = 0 // doit être consécutif
      }
      windowStart = now
      frames = 0
    }
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)
  return { stop }
}
