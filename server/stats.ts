import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { adminApp } from './firebaseAdmin.js'

// Compteurs de consultation des cartes publiées (collection Firestore
// `stats/<folder>`). On utilise Firestore et NON R2 parce que l'incrément doit
// être ATOMIQUE : plusieurs visiteurs simultanés sur la même carte ne doivent
// pas s'écraser, ce qu'un read-modify-write sur R2 ferait.
//
// Écrit uniquement par l'Admin SDK (serveur) et lu uniquement par l'API serveur :
// le client ne touche JAMAIS cette collection, donc aucune règle Firestore côté
// client n'est nécessaire. Les vues sont anonymes (aucun identifiant visiteur).

const STATS_COLLECTION = 'stats'

// Jour courant au format YYYY-MM-DD (UTC). Clé de la série quotidienne.
const dayKey = (date = new Date()): string => date.toISOString().slice(0, 10)

export type HikeStats = {
  total: number
  daily: Record<string, number>
}

// Enregistre UNE vue pour la carte `folder`. Best-effort : toute erreur est
// avalée pour ne JAMAIS interrompre la consultation publique (la stat est
// secondaire). L'incrément crée le document/champ s'il n'existe pas encore.
export const recordHikeView = async (folder: string): Promise<void> => {
  if (!folder) return
  try {
    const db = getFirestore(adminApp())
    await db
      .collection(STATS_COLLECTION)
      .doc(folder)
      .set(
        {
          total: FieldValue.increment(1),
          // Merge profond : n'écrase pas les autres jours déjà comptés.
          daily: { [dayKey()]: FieldValue.increment(1) },
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      )
  } catch {
    // Stat best-effort : on n'interrompt pas la réponse au visiteur.
  }
}

// ── Tuto de consultation ────────────────────────────────────────────────────
// Mesure du guide de découverte servi aux visiteurs. Strictement ANONYME et
// AGRÉGÉE : un seul document de compteurs, aucun identifiant visiteur, aucune
// trace individuelle. Même principe que les vues (incréments atomiques, écrits
// par l'Admin SDK depuis l'API, jamais par le client).

const TUTORIAL_COLLECTION = 'tutorial_stats'
const TUTORIAL_DOC = 'consultation'

const TUTORIAL_EVENTS = ['start', 'done', 'skip', 'never', 'abandon'] as const
export type TutorialEvent = (typeof TUTORIAL_EVENTS)[number]

export const isTutorialEvent = (value: unknown): value is TutorialEvent =>
  typeof value === 'string' &&
  (TUTORIAL_EVENTS as readonly string[]).includes(value)

// Compteur visé par chaque fin de parcours (`start` a son propre traitement).
const OUTCOME_FIELD: Record<Exclude<TutorialEvent, 'start'>, string> = {
  done: 'completed',
  skip: 'skipped',
  never: 'never',
  abandon: 'abandoned',
}

// La clé d'étape vient d'un client anonyme et devient une clé de map Firestore :
// on la filtre plutôt que de lui faire confiance.
const SAFE_STEP = /^[a-z0-9-]{1,24}$/

export type TutorialStats = {
  started: number
  completed: number
  skipped: number
  never: number
  abandoned: number
  /** Nombre d'arrêts par étape (clé d'étape → total). */
  dropoff: Record<string, number>
  /** Démarrages par jour (YYYY-MM-DD → total). */
  daily: Record<string, number>
}

const EMPTY_TUTORIAL_STATS: TutorialStats = {
  started: 0,
  completed: 0,
  skipped: 0,
  never: 0,
  abandoned: 0,
  dropoff: {},
  daily: {},
}

// Enregistre UNE issue du tuto. Best-effort : toute erreur est avalée.
export const recordTutorialEvent = async (
  event: TutorialEvent,
  step: string,
): Promise<void> => {
  try {
    const db = getFirestore(adminApp())
    const payload: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    }
    if (event === 'start') {
      payload.started = FieldValue.increment(1)
      payload.daily = { [dayKey()]: FieldValue.increment(1) }
    } else {
      payload[OUTCOME_FIELD[event]] = FieldValue.increment(1)
      // Où le visiteur s'est arrêté (sans objet s'il est allé au bout).
      if (event !== 'done' && SAFE_STEP.test(step)) {
        payload.dropoff = { [step]: FieldValue.increment(1) }
      }
    }
    await db
      .collection(TUTORIAL_COLLECTION)
      .doc(TUTORIAL_DOC)
      .set(payload, { merge: true })
  } catch {
    // Stat best-effort : on n'interrompt jamais le visiteur.
  }
}

// Lit les compteurs du tuto pour la console d'admin. Jamais d'erreur remontée :
// un tuto sans mesure renvoie des zéros.
export const readTutorialStats = async (): Promise<TutorialStats> => {
  try {
    const db = getFirestore(adminApp())
    const snapshot = await db
      .collection(TUTORIAL_COLLECTION)
      .doc(TUTORIAL_DOC)
      .get()
    const data = snapshot.data()
    if (!data) return EMPTY_TUTORIAL_STATS
    const num = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0
    const counters = (value: unknown): Record<string, number> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, number>)
        : {}
    return {
      started: num(data.started),
      completed: num(data.completed),
      skipped: num(data.skipped),
      never: num(data.never),
      abandoned: num(data.abandoned),
      dropoff: counters(data.dropoff),
      daily: counters(data.daily),
    }
  } catch {
    return EMPTY_TUTORIAL_STATS
  }
}

// Lit en UN aller-retour les compteurs des cartes demandées. Un folder sans
// document (jamais consulté) renvoie des compteurs à zéro.
export const readHikesStats = async (
  folders: string[],
): Promise<Map<string, HikeStats>> => {
  const result = new Map<string, HikeStats>()
  if (folders.length === 0) return result
  const db = getFirestore(adminApp())
  const refs = folders.map((folder) =>
    db.collection(STATS_COLLECTION).doc(folder),
  )
  const snapshots = await db.getAll(...refs)
  for (const snapshot of snapshots) {
    const data = snapshot.data() ?? {}
    const daily =
      data.daily && typeof data.daily === 'object'
        ? (data.daily as Record<string, number>)
        : {}
    result.set(snapshot.id, {
      total: typeof data.total === 'number' ? data.total : 0,
      daily,
    })
  }
  return result
}
