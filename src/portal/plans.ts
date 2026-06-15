// Catalogue des forfaits côté client (présentation). Les limites RÉELLEMENT
// appliquées vivent côté serveur (`server/plans.ts`) ; ici c'est l'affichage.
// Un seul forfait est réel pour l'instant (Standard, gratuit) : les autres sont
// des aperçus « à venir » pour donner une idée de la suite.
export type PlanId = 'standard' | 'explorateur' | 'cartographe'

export type PortalPlan = {
  id: PlanId
  name: string
  tagline: string
  // Prix affiché (libellé) + suffixe (« /mois », « gratuit »…).
  priceLabel: string
  priceSuffix: string
  storageLabel: string
  features: string[]
  // false = forfait factice, pas encore disponible (« Bientôt »).
  available: boolean
  highlight?: boolean
}

export const DEFAULT_PLAN_ID: PlanId = 'standard'

export const PLANS: PortalPlan[] = [
  {
    id: 'standard',
    name: 'Standard',
    tagline: 'Pour démarrer et raconter vos premières aventures.',
    priceLabel: 'Gratuit',
    priceSuffix: 'pour toujours',
    storageLabel: '5 Go de stockage',
    features: [
      '5 Go de médias (toutes cartes confondues)',
      'Cartes illimitées',
      'Relief 3D et médias géolocalisés',
      'Partage par lien',
    ],
    available: true,
    highlight: true,
  },
  {
    id: 'explorateur',
    name: 'Explorateur',
    tagline: 'Plus d’espace et de qualité pour les grands voyages.',
    priceLabel: '5 €',
    priceSuffix: '/ mois',
    storageLabel: '50 Go de stockage',
    features: [
      '50 Go de médias',
      'Vidéos jusqu’en 4K',
      'Pages publiques personnalisées',
      'Support prioritaire',
    ],
    available: false,
  },
  {
    id: 'cartographe',
    name: 'Cartographe',
    tagline: 'Pour les créateurs qui publient beaucoup.',
    priceLabel: '12 €',
    priceSuffix: '/ mois',
    storageLabel: '200 Go de stockage',
    features: [
      '200 Go de médias',
      'Pages publiques illimitées',
      'Statistiques de consultation',
      'Domaine de partage dédié',
    ],
    available: false,
  },
]

export const planById = (id: string | undefined): PortalPlan =>
  PLANS.find((plan) => plan.id === id) ?? PLANS[0]

// Formatage d'octets (base décimale, cohérent avec les limites en Go).
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Mo'
  const gigabytes = bytes / 1_000_000_000
  if (gigabytes >= 1) {
    return `${gigabytes.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Go`
  }
  const megabytes = bytes / 1_000_000
  return `${megabytes.toLocaleString('fr-FR', {
    maximumFractionDigits: megabytes >= 10 ? 0 : 1,
  })} Mo`
}
