// Médias « en 2 temps » (opti perf) : la carte affiche d'abord le visible
// (vignettes, avant le voile), puis, UNE FOIS le voile levé, quelques photos
// pleine taille partent en tâche de fond à faible concurrence → l'ouverture
// de la lightbox et le diaporama deviennent instantanés pour les premiers
// médias, sans peser sur le chemin critique d'affichage ni sur les tuiles.
//
// Le préchargement IMITE exactement la requête de la lightbox : <img> sans
// crossOrigin pour les photos, crossOrigin 'anonymous' pour les 360 (comme
// Panorama360). Le videur répond `Vary: Origin` : un mode différent créerait
// une entrée de cache distincte et le préchargement ne servirait à rien.
//
// ⚠️ 2026-07-20 : sur une grande carte (Lofoten, 152 photos ~535 Mo), ce
// préchargement SANS PLAFOND a fait planter des visiteurs mobiles (mémoire
// + données) — `navigator.connection` n'existe pas sur Safari/iOS, la garde
// « pas de prefetch en économie de données » ne s'y appliquait donc jamais.
// Double garde désormais : plafond dur (`MAX_PREFETCH_ITEMS`) ET jamais sur
// tactile (mobile/tablette), où la RAM et le forfait data sont les plus
// contraints — seuls les postes de bureau bénéficient du confort du prefetch.

export type MediaPrefetchItem = { src: string; kind: 'image' | '360' }

// Sources déjà préchargées cette session (évite de re-télécharger au remontage).
const alreadyPrefetched = new Set<string>()
const MAX_CONCURRENT = 2
// Ne précharge que le début du diaporama (les clics probables) : le reste se
// chargera à la demande, au clic, comme avant cette optimisation.
export const MAX_PREFETCH_ITEMS = 12

// Un appareil à écran tactile (téléphone, tablette) n'a pas de pointeur fin :
// c'est le signal le plus fiable, disponible partout (y compris Safari/iOS,
// où `navigator.connection` n'existe pas).
const isTouchDevice = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches

// Respecte l'économiseur de données et les connexions très lentes : sur ces
// profils, précharger même quelques photos serait hostile. Absent sur
// Safari/iOS (`connection` undefined) : c'est `isTouchDevice` qui protège
// alors les mobiles, cette garde reste utile sur Chrome Android/desktop.
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
  if (isTouchDevice()) return () => undefined
  if (!connectionAllowsPrefetch()) return () => undefined
  const queue = items
    .slice(0, MAX_PREFETCH_ITEMS)
    .filter((item) => item.src && !alreadyPrefetched.has(item.src))
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
