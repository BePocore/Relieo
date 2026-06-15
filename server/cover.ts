// Choix d'une image de couverture au hasard parmi les médias d'une carte.
// Sert à donner une vignette au dashboard quand aucune cover n'a été définie.
// On privilégie les vignettes (thumbnailUrl) plus légères, et on ignore les
// vidéos et les URLs blob (non persistées).
type CoverMedia = {
  url?: unknown
  thumbnailUrl?: unknown
  kind?: unknown
}

type CoverProject = {
  mediaLibrary?: CoverMedia[]
  points?: Array<{ image?: unknown }>
}

const usableUrl = (value: unknown): string | null =>
  typeof value === 'string' && value && !value.startsWith('blob:')
    ? value
    : null

export const pickRandomCoverUrl = (
  project: CoverProject,
): string | undefined => {
  const candidates: string[] = []

  for (const media of project.mediaLibrary ?? []) {
    if (media.kind === 'video') continue
    const url = usableUrl(media.thumbnailUrl) ?? usableUrl(media.url)
    if (url) candidates.push(url)
  }

  // Repli : images attachées aux points si la bibliothèque est vide.
  if (candidates.length === 0) {
    for (const point of project.points ?? []) {
      const url = usableUrl(point.image)
      if (url) candidates.push(url)
    }
  }

  if (candidates.length === 0) return undefined
  return candidates[Math.floor(Math.random() * candidates.length)]
}

// Pioche une cover directement depuis le texte JSON d'un project.json.
export const pickCoverFromProjectJson = (
  body: string | null,
): string | undefined => {
  if (!body) return undefined
  try {
    return pickRandomCoverUrl(JSON.parse(body) as CoverProject)
  } catch {
    return undefined
  }
}
