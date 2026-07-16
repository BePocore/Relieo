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

// Libellé contextuel d'un média pour la lightbox. Priorité au titre : un vrai
// titre saisi passe en tête (lieu + date en sous-titre) ; sinon le lieu géocodé
// ; sinon la date de prise ; à défaut le nom de fichier tel quel.
export const mediaCaption = (
  title: string | undefined,
  takenAt: string | undefined,
  placeName?: string,
): { primary: string; secondary?: string } => {
  const name = title?.trim() ?? ''
  const place = placeName?.trim() || undefined
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
  const dateTime = dateLabel
    ? timeLabel
      ? `${dateLabel} · ${timeLabel}`
      : dateLabel
    : undefined

  // Vrai titre saisi par le créateur : on le garde, contexte dessous.
  if (name && !isGenericMediaName(name)) {
    const secondary = [place, dateTime].filter(Boolean).join(' · ') || undefined
    return { primary: name, secondary }
  }
  // Lieu géocodé : contexte le plus parlant à défaut de titre.
  if (place) {
    return { primary: place, secondary: dateTime }
  }
  // Date de prise.
  if (dateLabel) {
    return { primary: dateLabel, secondary: timeLabel }
  }
  return { primary: name || 'Média' }
}
