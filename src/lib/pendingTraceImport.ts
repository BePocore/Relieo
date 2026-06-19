import type { TrackPoint } from '../types'

// Passe-plat (handoff) pour importer une trace GPS enregistree dans Relieo vers
// le Studio d'une carte existante : l'onglet Traces depose la trace ici puis
// navigue vers `/?mode=studio&code=<code>`, et le Studio la consomme au montage.
const KEY = 'relieo.pending-trace-import'

export type PendingTraceImport = {
  code: string
  name: string
  points: TrackPoint[]
}

export const setPendingTraceImport = (value: PendingTraceImport): void => {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // sessionStorage indisponible : l'import sera simplement ignore.
  }
}

// Lecture destructive : on retire l'entree pour ne pas reimporter au rechargement.
export const takePendingTraceImport = (): PendingTraceImport | null => {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(KEY)
    const parsed = JSON.parse(raw) as Partial<PendingTraceImport>
    if (typeof parsed.code !== 'string' || !Array.isArray(parsed.points)) {
      return null
    }
    return {
      code: parsed.code,
      name: typeof parsed.name === 'string' ? parsed.name : 'Trace',
      points: parsed.points as TrackPoint[],
    }
  } catch {
    return null
  }
}
