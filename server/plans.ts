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

// --- Coût d'infrastructure Cloudflare R2 (pour le dashboard admin) ---
// R2 facture le stockage à l'usage : 10 Go gratuits par mois, puis ~0,015 €/Go
// par mois (egress gratuit, ops négligeables). Valeurs approximatives et
// pilotables ici. `R2_FREE_BYTES` est le palier gratuit global du bucket.
export const R2_COST_PER_GB_EUR = 0.015
export const R2_FREE_BYTES = 10_000_000_000

const BYTES_PER_GB = 1_000_000_000

// Coût mensuel réel d'un volume d'octets, hors palier gratuit (déjà décompté au
// niveau du bucket). Utilisé tel quel pour le coût global ; pour un utilisateur
// pris isolément, on facture chaque Go (le gratuit est mutualisé au bucket).
export const monthlyR2Cost = (bytes: number, applyFreeTier = false): number => {
  const billableBytes = applyFreeTier
    ? Math.max(0, bytes - R2_FREE_BYTES)
    : Math.max(0, bytes)
  return (billableBytes / BYTES_PER_GB) * R2_COST_PER_GB_EUR
}
