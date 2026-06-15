// Catalogue des forfaits côté serveur : uniquement ce qui touche à
// l'application des limites (quota de stockage). La présentation marketing des
// forfaits vit côté client dans `src/portal/plans.ts` ; garder les deux en phase.
export type PlanId = 'standard' | 'explorateur' | 'cartographe'

// Limite de stockage par forfait, en octets, pour l'utilisateur ENTIER
// (toutes ses randonnées cumulées).
export const PLAN_STORAGE_LIMITS: Record<PlanId, number> = {
  standard: 5_000_000_000,
  explorateur: 50_000_000_000,
  cartographe: 200_000_000_000,
}

export const DEFAULT_PLAN_ID: PlanId = 'standard'

// Limite du forfait gratuit (Standard) : référence utilisée tant que tous les
// utilisateurs sont en gratuit. Le jour où les forfaits payants existent, on
// lira le `plan` du profil pour choisir la bonne limite.
export const FREE_STORAGE_LIMIT_BYTES = PLAN_STORAGE_LIMITS.standard

export const planStorageLimit = (planId: string | undefined): number => {
  if (planId && planId in PLAN_STORAGE_LIMITS) {
    return PLAN_STORAGE_LIMITS[planId as PlanId]
  }
  return PLAN_STORAGE_LIMITS[DEFAULT_PLAN_ID]
}
