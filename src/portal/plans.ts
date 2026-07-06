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
  // Prix mensuel réel en euros (0 = gratuit). Sert au calcul du revenu admin.
  monthlyPriceEur: number
  storageLabel: string
  // Équivalence lisible du stockage (ex « ≈ 250 photos ou 20 vidéos »), affichée
  // sous le stockage. Absente pour un stockage illimité.
  storageEquivalence?: string
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
    monthlyPriceEur: 0,
    storageLabel: '1 Go de stockage',
    // Correspondances calculées pour du 4K (photo ~5 Mo ; vidéo ~250 Mo / 30 s
    // = 8,3 Mo/s). La vidéo est donnée en DURÉE (un « nombre de vidéos » ne veut
    // rien dire, la durée varie). 1 Go = 1000 Mo (base décimale, comme R2).
    // → 1000/5 = 200 photos ; 1000/8,3 = 120 s = 2 min de vidéo.
    storageEquivalence: '≈ 200 photos ou 2 min de vidéo, en 4K',
    features: [
      "Jusqu'à 3 cartes",
      'Relief 3D',
      'Médias géolocalisés',
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
    monthlyPriceEur: 5,
    storageLabel: '50 Go de stockage',
    // 50 000 Mo → 10 000 photos ; 50 000/8,3 = 6000 s ≈ 1 h 40 de vidéo 4K.
    storageEquivalence: '≈ 10 000 photos ou 1 h 40 de vidéo, en 4K',
    features: [
      'Cartes illimitées',
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
    monthlyPriceEur: 12,
    storageLabel: 'Stockage illimité',
    features: [
      'Stockage illimité',
      'Cartes illimitées',
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
