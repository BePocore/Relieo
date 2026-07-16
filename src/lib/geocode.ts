// Géocodage inverse (coordonnées → nom de lieu), via l'API navigateur gratuite
// de BigDataCloud (reverse-geocode-client, sans clé, CORS ouvert, pensée pour
// un appel côté client en volume). Appelé UNE fois par point dans le Studio, en
// tâche de fond, puis le résultat est stocké dans `TrailPoint.placeName`
// (project.json) : en consultation c'est du texte, zéro requête, zéro coût.
//
// Best-effort : toute erreur → null (on retombe alors sur la date dans la
// lightbox). Le créateur envoie les coordonnées de SES médias pour les nommer.

type BigDataCloudResponse = {
  locality?: string
  city?: string
  principalSubdivision?: string
  countryName?: string
}

export const reverseGeocode = async (
  lat: number,
  lng: number,
): Promise<string | null> => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  try {
    const url =
      'https://api.bigdatacloud.net/data/reverse-geocode-client' +
      `?latitude=${lat}&longitude=${lng}&localityLanguage=fr`
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const data = (await response.json()) as BigDataCloudResponse
    const locality =
      data.locality?.trim() ||
      data.city?.trim() ||
      data.principalSubdivision?.trim()
    // Les noms de pays FR de BigDataCloud portent un article entre parenthèses
    // (« Norvège (la) ») : on le retire.
    const country = data.countryName
      ?.replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
    const label = [locality, country].filter(Boolean).join(', ')
    return label || null
  } catch {
    return null
  }
}
