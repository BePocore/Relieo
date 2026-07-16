export const formatDistance = (meters: number): string => {
  if (!Number.isFinite(meters) || meters <= 0) return '--'

  const kilometers = meters / 1000
  return `${kilometers.toLocaleString('fr-FR', {
    maximumFractionDigits: kilometers < 10 ? 2 : 1,
  })} km`
}

export const formatElevation = (meters: number | null | undefined): string => {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return '--'
  }

  return `${Math.round(meters).toLocaleString('fr-FR')} m`
}

export const formatGain = (meters: number): string => {
  if (!Number.isFinite(meters) || meters <= 0) return '--'

  return `${Math.round(meters).toLocaleString('fr-FR')} m`
}

export const formatLoss = (meters: number): string => {
  if (!Number.isFinite(meters) || meters <= 0) return '--'

  return `${Math.round(meters).toLocaleString('fr-FR')} m`
}

// Un nom de fichier d'appareil (IMG_0245, DSC0123, PXL_2026…, 20260812_1432…)
// n'apporte rien : dans ces cas on préfère afficher la date de prise.
const GENERIC_NAME_PREFIX =
  /^(img|dsc|dscf|dscn|pxl|vid|mvimg|mov|gopr|dji|p|photo|image|screenshot|capture|snap|scan)[-_ ]?\d/i

export const isGenericMediaName = (name: string): boolean => {
  const base = name.replace(/\.[a-z0-9]+$/i, '').trim()
  if (!base) return true
  if (GENERIC_NAME_PREFIX.test(base)) return true
  // Un seul « mot » sans espace, fait de lettres/chiffres et contenant des
  // chiffres (ex « 20260812_143200 »).
  if (!/\s/.test(base) && /\d/.test(base) && /^[a-z0-9_-]+$/i.test(base)) {
    return true
  }
  return false
}

// Libellé contextuel d'un média pour la lightbox : remplace un nom de fichier
// générique par la date de prise (heure en sous-titre), ou garde un vrai titre
// avec la date + heure dessous. Sans date exploitable, garde le nom tel quel.
export const mediaCaption = (
  title: string | undefined,
  takenAt: string | undefined,
): { primary: string; secondary?: string } => {
  const name = title?.trim() ?? ''
  const parsed = takenAt ? new Date(takenAt) : null
  const date = parsed && Number.isFinite(parsed.getTime()) ? parsed : null
  const dateLabel = date
    ? new Intl.DateTimeFormat('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }).format(date)
    : undefined
  const timeLabel = date
    ? new Intl.DateTimeFormat('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }).format(date)
    : undefined

  if (!name || isGenericMediaName(name)) {
    if (dateLabel) return { primary: dateLabel, secondary: timeLabel }
    return { primary: name || 'Média' }
  }
  const secondary = dateLabel
    ? timeLabel
      ? `${dateLabel} · ${timeLabel}`
      : dateLabel
    : undefined
  return { primary: name, secondary }
}
