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
