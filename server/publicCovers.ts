import {
  mediaBaseUrl,
  r2CopyObjects,
  r2DeleteObject,
  r2KeyFromPublicUrl,
} from './r2.js'

// Miroir PUBLIC des couvertures de cartes. Le contenu des cartes est servi par
// le « videur » sous ticket ; mais un feed social a besoin d'afficher la
// couverture sans ticket. On copie donc la couverture des cartes PUBLIÉES vers
// `relieo/public/covers/<slug>`, un chemin que le videur sert SANS ticket (et
// SANS jamais exposer le reste du contenu privé). Une carte à code y figure
// aussi : seule sa couverture est publique, son contenu reste verrouillé.
const PUBLIC_COVER_PREFIX = 'relieo/public/covers/'

export const publicCoverKey = (slug: string): string =>
  `${PUBLIC_COVER_PREFIX}${slug}`

export const publicCoverUrl = (slug: string): string =>
  `${mediaBaseUrl()}/${PUBLIC_COVER_PREFIX}${encodeURIComponent(slug)}`

// Copie/rafraîchit (ou retire) la couverture publique d'une carte. Best-effort :
// ne jette jamais (une couverture manquante retombe sur le dégradé côté client).
// `force` remplace un miroir existant (changement de couverture) ; sinon on ne
// copie que s'il manque (backfill léger, sans réécrire ce qui existe déjà).
export const syncPublicCover = async (
  entry: { slug?: string; status: string; coverUrl?: string },
  options?: { force?: boolean },
): Promise<void> => {
  const slug = entry.slug?.trim()
  if (!slug) return
  const destKey = publicCoverKey(slug)
  try {
    if (entry.status === 'published' && entry.coverUrl) {
      const sourceKey = r2KeyFromPublicUrl(entry.coverUrl)
      if (!sourceKey) return
      if (options?.force) await r2DeleteObject(destKey).catch(() => undefined)
      // skipQuota : le quota global est illimité et une couverture est minuscule ;
      // surtout, ça évite un scan complet du bucket à chaque copie.
      await r2CopyObjects([{ sourceKey, destinationKey: destKey }], {
        skipQuota: true,
      })
    } else {
      // Carte dépubliée / brouillon : plus de couverture publique.
      await r2DeleteObject(destKey).catch(() => undefined)
    }
  } catch {
    // best-effort
  }
}

export const deletePublicCover = async (slug?: string): Promise<void> => {
  const trimmed = slug?.trim()
  if (!trimmed) return
  await r2DeleteObject(publicCoverKey(trimmed)).catch(() => undefined)
}
