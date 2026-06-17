import { r2GetText, r2PutText } from './r2.js'

// Journal de modération admin : trace chaque action (dépublication, suppression)
// avec qui, quand, sur quelle carte, et le message éventuel transmis. Stocké
// dans R2 comme un simple JSON, à l'image de `index.json`.
export const sanctionsPath = 'relieo/sanctions.json'

// Actions sur les cartes (unpublish/delete) ET sur les comptes (block/unblock/
// delete-account). Pour les sanctions de compte, mapCode/mapTitle restent vides
// et targetUid/targetEmail désignent l'utilisateur visé.
export type SanctionAction =
  | 'unpublish'
  | 'delete'
  | 'block'
  | 'unblock'
  | 'delete-account'

export type SanctionEntry = {
  id: string
  action: SanctionAction
  mapCode: string
  mapTitle: string
  ownerId: string
  ownerEmail: string | null
  // Utilisateur visé par une sanction de compte (sinon vide).
  targetUid?: string
  targetEmail?: string | null
  adminUid: string
  adminEmail: string | null
  message: string
  createdAt: string
}

// Plafond pour borner la taille du fichier (le journal garde les plus récents).
const MAX_ENTRIES = 1000

export const readSanctions = async (): Promise<SanctionEntry[]> => {
  const body = await r2GetText(sanctionsPath)
  if (!body) return []
  try {
    const value = JSON.parse(body) as { sanctions?: unknown }
    return Array.isArray(value.sanctions)
      ? (value.sanctions as SanctionEntry[])
      : []
  } catch {
    return []
  }
}

// Ajoute une entrée en tête (plus récent d'abord), sans écraser les autres.
export const appendSanction = async (entry: SanctionEntry): Promise<void> => {
  const current = await readSanctions()
  const next = [entry, ...current].slice(0, MAX_ENTRIES)
  await r2PutText(sanctionsPath, JSON.stringify({ sanctions: next }))
}
