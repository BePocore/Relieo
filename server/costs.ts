// Coûts FIXES du projet (domaine, futurs abonnements). Aucune saisie manuelle
// dans l'interface : la vérité vit ici (ou, à terme, sera récupérée via les API
// des plateformes quand ce sera pertinent). On complète cette liste ensemble au
// fil des dépenses réelles, jamais à la main côté admin.
export type FixedCost = {
  id: string
  name: string
  detail: string
  yearlyEur: number
  // Prochaine échéance de paiement (ISO), si pertinent.
  renewsAt?: string
}

export const FIXED_COSTS: FixedCost[] = [
  {
    id: 'domain',
    name: 'Domaine relieo.fr (OVH)',
    detail: 'Nom de domaine, 6 €/an',
    yearlyEur: 6,
    // Acheté le 2026-06-16 pour 3 ans.
    renewsAt: '2029-06-16',
  },
]
