// Préchargements de la consultation publique, démarrés dès le chunk d'entrée
// (Root) : la requête projet et le ticket média partent en parallèle du
// téléchargement du chunk App, au lieu d'attendre le montage de l'application.
// Casse la cascade mesurée à l'audit de perf : index → App → api/project →
// chunk carte (6,3 s en wifi, ~21 s en 3G alors que chaque pièce est rapide).
//
// Uniquement pour la consultation publique (pas de jeton Firebase requis) :
// le Studio garde son chargement authentifié classique.
import { requestMediaTicket } from './mediaTicket'

let projectFetch: {
  endpoint: string
  promise: Promise<Response | null>
} | null = null

let mediaTicket: {
  slug: string
  promise: Promise<number | null>
} | null = null

export function startEarlyConsultation(): void {
  const params = new URLSearchParams(window.location.search)
  const slug = (params.get('m') ?? params.get('code'))?.trim() ?? ''
  if (!slug) return
  // Requête identique à celle de App.tsx (loadTrail), pour que la réponse
  // préchargée soit interchangeable avec une requête normale.
  const endpoint = `/api/project?m=${encodeURIComponent(slug)}`
  projectFetch = {
    endpoint,
    promise: fetch(endpoint, {
      cache: 'no-store',
      credentials: 'include',
    }).catch(() => null),
  }
  // Ticket média chaîné sur la réponse projet : il ne part que si la carte
  // est réellement publique (contenu complet, non protégée). Une carte à code
  // ne déclenche AUCUNE demande sans code d'accès (sinon 401 systématique en
  // console) : sa porte de code gère le ticket, comme avant. Le chaînage ne
  // coûte rien au chemin critique : la réponse projet arrive pendant le
  // téléchargement du chunk App, le ticket part à ce moment-là.
  mediaTicket = {
    slug,
    promise: projectFetch.promise.then(async (response) => {
      if (!response?.ok) return null
      try {
        // clone() : App consommera le corps de la réponse originale.
        const data = (await response.clone().json()) as {
          protected?: boolean
          isProtected?: boolean
          points?: unknown
        }
        if (!Array.isArray(data.points)) return null
        if (data.protected === true || data.isProtected === true) return null
      } catch {
        return null
      }
      return requestMediaTicket({ code: slug })
    }),
  }
}

// Réponse projet préchargée, consommée UNE seule fois et seulement si
// l'endpoint correspond exactement (sinon App fait sa requête normale).
export function takeEarlyProjectFetch(
  endpoint: string,
): Promise<Response | null> | null {
  if (!projectFetch || projectFetch.endpoint !== endpoint) return null
  const { promise } = projectFetch
  projectFetch = null
  return promise
}

// Ticket média préchargé (délai de rafraîchissement, ou null si échec),
// mêmes règles de consommation.
export function takeEarlyMediaTicket(
  slug: string,
): Promise<number | null> | null {
  if (!mediaTicket || mediaTicket.slug !== slug) return null
  const { promise } = mediaTicket
  mediaTicket = null
  return promise
}
