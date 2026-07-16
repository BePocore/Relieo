// Médias « en 2 temps » (opti perf) : la carte affiche d'abord le visible
// (vignettes, avant le voile), puis, UNE FOIS le voile levé, les photos
// pleine taille partent en tâche de fond à faible concurrence → l'ouverture
// de la lightbox et le diaporama deviennent instantanés, sans peser sur le
// chemin critique d'affichage ni sur les tuiles de carte.
//
// Le préchargement IMITE exactement la requête de la lightbox : <img> sans
// crossOrigin pour les photos, crossOrigin 'anonymous' pour les 360 (comme
// Panorama360). Le videur répond `Vary: Origin` : un mode différent créerait
// une entrée de cache distincte et le préchargement ne servirait à rien.

export type MediaPrefetchItem = { src: string; kind: 'image' | '360' }

// Sources déjà préchargées cette session (évite de re-télécharger au remontage).
const alreadyPrefetched = new Set<string>()
const MAX_CONCURRENT = 2

// Respecte l'économiseur de données et les connexions très lentes : sur ces
// profils, précharger toutes les photos du séjour serait hostile.
const connectionAllowsPrefetch = (): boolean => {
  const connection = (
    navigator as {
      connection?: { saveData?: boolean; effectiveType?: string }
    }
  ).connection
  if (!connection) return true
  if (connection.saveData) return false
  const type = connection.effectiveType ?? ''
  return type !== 'slow-2g' && type !== '2g'
}

const loadOne = (item: MediaPrefetchItem): Promise<void> =>
  new Promise((resolve) => {
    const image = new Image()
    if (item.kind === '360') image.crossOrigin = 'anonymous'
    image.onload = () => resolve()
    image.onerror = () => resolve()
    image.src = item.src
  })

// Lance le préchargement (l'ordre reçu = ordre de lecture, donc l'ordre des
// clics probables). Renvoie une fonction d'arrêt : les téléchargements en
// cours se terminent, plus aucun nouveau ne part.
export function startMediaPrefetch(items: MediaPrefetchItem[]): () => void {
  if (!connectionAllowsPrefetch()) return () => undefined
  const queue = items.filter(
    (item) => item.src && !alreadyPrefetched.has(item.src),
  )
  let stopped = false
  let index = 0
  let active = 0
  const next = (): void => {
    if (stopped) return
    while (active < MAX_CONCURRENT && index < queue.length) {
      const item = queue[index]
      index += 1
      if (alreadyPrefetched.has(item.src)) continue
      alreadyPrefetched.add(item.src)
      active += 1
      void loadOne(item).then(() => {
        active -= 1
        next()
      })
    }
  }
  next()
  return () => {
    stopped = true
  }
}
