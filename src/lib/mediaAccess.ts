// Acces aux medias servis par le « videur » (media.relieo.fr), proteges par un
// cookie ticket. Pour dessiner ces medias dans un canvas (miniatures, posters
// video), la requete CORS doit ENVOYER le cookie -> crossOrigin "use-credentials"
// (et credentials "include" pour fetch). Ailleurs (anciennes URLs r2.dev en
// Studio), on reste en "anonymous"/"same-origin" comme avant.

const MEDIA_HOST = 'media.relieo.fr'

export const isProtectedMedia = (src: string): boolean =>
  src.includes(`//${MEDIA_HOST}/`)

export const mediaCrossOrigin = (src: string): 'anonymous' | 'use-credentials' =>
  isProtectedMedia(src) ? 'use-credentials' : 'anonymous'

export const mediaFetchCredentials = (src: string): RequestCredentials =>
  isProtectedMedia(src) ? 'include' : 'same-origin'
