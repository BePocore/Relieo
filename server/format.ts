// Formatage d'une taille en octets vers une chaîne lisible (Go/Mo), en
// français. Base décimale (1 Go = 1 000 000 000 o) pour rester cohérent avec
// les limites de forfait exprimées en Go décimaux.
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Mo'
  const gigabytes = bytes / 1_000_000_000
  if (gigabytes >= 1) {
    return `${gigabytes.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Go`
  }
  const megabytes = bytes / 1_000_000
  return `${megabytes.toLocaleString('fr-FR', { maximumFractionDigits: megabytes >= 10 ? 0 : 1 })} Mo`
}
