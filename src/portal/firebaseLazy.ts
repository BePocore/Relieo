// Façade paresseuse de firebase.ts pour le graphe de la CARTE (App.tsx et ses
// composants) : le SDK Firebase (~110 Ko gzip) n'est téléchargé qu'au premier
// appel réel (chargement d'un brouillon en Studio, sauvegarde...), jamais en
// consultation publique — il était sinon dans le chemin critique d'affichage.
// Le portail (PortalApp) garde son import statique classique de firebase.ts.
export { firebaseEnabled } from './firebaseConfig'
import { firebaseEnabled } from './firebaseConfig'

let modulePromise: Promise<typeof import('./firebase')> | null = null

const loadFirebase = (): Promise<typeof import('./firebase')> => {
  modulePromise ??= import('./firebase')
  return modulePromise
}

// Même contrat que firebase.ts : null si Firebase off, personne de connecté,
// ou SDK impossible à charger (hors-ligne) — les appelants gèrent déjà null.
export const getIdToken = async (): Promise<string | null> => {
  if (!firebaseEnabled) return null
  try {
    return await (await loadFirebase()).getIdToken()
  } catch {
    modulePromise = null
    return null
  }
}
