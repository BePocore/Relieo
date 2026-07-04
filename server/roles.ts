// Rôle de compte : « viewer » (par défaut) ou « creator » (publie des cartes et
// accède au dashboard créateur). Calqué sur `server/admin.ts` : la source de
// vérité est une allowlist d'uid en variable d'env (`CREATOR_UIDS`, CSV), jamais
// un champ inscriptible par le client (sinon auto-promotion).

export type AccountType = 'viewer' | 'creator'

// Uid Firebase explicitement désignés créateurs (CSV dans `CREATOR_UIDS`).
const creatorUids = (): string[] =>
  (process.env.CREATOR_UIDS ?? '')
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean)

export const isCreatorUid = (uid: string): boolean =>
  creatorUids().includes(uid)

// Résout le rôle d'un compte. Créateur si l'uid est dans l'allowlist d'env OU si
// le profil porte déjà le flag `accountType: 'creator'` (posé plus tard par le
// bouton « devenir créateur », via une action serveur contrôlée). Sinon viewer.
export const resolveAccountType = (
  uid: string,
  storedAccountType?: string,
): AccountType =>
  isCreatorUid(uid) || storedAccountType === 'creator' ? 'creator' : 'viewer'
