import {
  hasR2Config,
  r2DeleteObject,
  r2DeletePrefix,
  r2GetText,
  r2ListKeys,
  r2PutText,
  rewriteMediaUrls,
} from '../server/r2.js'
import { readHikeIndex, removeHikeIndex, upsertHikeIndex } from '../server/hikeIndex.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { isAdminUser } from '../server/admin.js'
import { activeTrailPath, trailFolder, trailLocation } from '../server/trailStorage.js'
import { signalModerationScan } from '../server/mediaModeration.js'
import { pickCoverFromProjectJson } from '../server/cover.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

export async function GET(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  if (!hasFirebaseAdmin()) {
    return Response.json(
      { message: 'Firebase Admin n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  const user = await verifyRequestUser(request)
  if (!user) {
    return Response.json(
      { message: 'Connexion requise.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const hikes = await readHikeIndex()
    const filtered = hikes.filter((hike) => hike.ownerId === user.uid)

    // Backfill des cartes publiées sans cover : on pioche une image au hasard
    // dans leur project.json et on la persiste une fois (les sauvegardes
    // suivantes la fournissent déjà). Limité aux cartes publiées et borné pour
    // ne pas multiplier les lectures lourdes sur un dashboard chargé.
    const missing = filtered
      .filter((hike) => !hike.coverUrl && hike.status === 'published')
      .slice(0, 12)
    for (const hike of missing) {
      const body = await r2GetText(
        trailLocation(hike.ownerId, hike.code).projectKey,
      )
      const coverUrl = pickCoverFromProjectJson(body)
      if (coverUrl) {
        hike.coverUrl = coverUrl
        await upsertHikeIndex({ folder: hike.folder, coverUrl })
      }
    }

    // Covers réécrites vers le videur media.relieo.fr (le dashboard les charge
    // avec un ticket « scope user »).
    return new Response(rewriteMediaUrls(JSON.stringify({ hikes: filtered })), {
      headers: { ...jsonHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return Response.json(
      {
        code: 'STORAGE_READ_FAILED',
        message: error instanceof Error ? error.message : 'Lecture R2 impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}

// Le propriétaire (ou l'admin) change le STATUT de sa carte sans toucher au
// contenu : passer en brouillon la retire du public (et coupe le pointeur public
// si elle en était la carte par défaut) ; publier la remet en ligne. Le
// project.json et les médias R2 ne sont JAMAIS modifiés ici.
export async function POST(request: Request) {
  if (!hasR2Config() || !hasFirebaseAdmin()) {
    return Response.json(
      { message: 'Service indisponible.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  const user = await verifyRequestUser(request)
  if (!user) {
    return Response.json(
      { message: 'Connexion requise.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const body = (await request.json()) as { code?: string; status?: string }
    const code = body.code?.trim()
    const status =
      body.status === 'draft'
        ? 'draft'
        : body.status === 'published'
          ? 'published'
          : null
    if (!code || !status) {
      return Response.json(
        { message: 'code et status (published|draft) sont obligatoires.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const folder = trailFolder(code)
    const entry = (await readHikeIndex()).find((hike) => hike.folder === folder)
    if (!entry) {
      return Response.json(
        { message: 'Carte introuvable.' },
        { status: 404, headers: jsonHeaders },
      )
    }
    if (entry.ownerId !== user.uid && !isAdminUser(user)) {
      return Response.json(
        { message: 'Cette carte appartient à un autre utilisateur.' },
        { status: 403, headers: jsonHeaders },
      )
    }

    // Statut uniquement : on ne réécrit pas le project.json (contenu préservé).
    await upsertHikeIndex({ folder, status })

    // Pointeur public : coupé si on dépublie la carte active ; (ré)initialisé
    // s'il n'existe pas quand on publie.
    const activeBody = await r2GetText(activeTrailPath)
    if (status === 'draft') {
      if (activeBody) {
        try {
          const active = JSON.parse(activeBody) as { folder?: string }
          if (active?.folder === folder) await r2DeleteObject(activeTrailPath)
        } catch {
          // active.json illisible : on n'y touche pas.
        }
      }
    } else if (!activeBody) {
      await r2PutText(activeTrailPath, JSON.stringify(trailLocation(entry.ownerId, code)))
    }

    // Modération : à la publication, on demande au videur de scanner EN PRIORITÉ
    // les médias de cette carte (file prioritaire). Tout est conditionné à la
    // présence du secret : tant que la modération n'est pas configurée, on ne fait
    // RIEN (pas même le listing R2) ; le cron 2×/jour rattrape une fois activé.
    if (status === 'published' && process.env.MODERATION_SIGNAL_SECRET) {
      try {
        const prefix = trailLocation(entry.ownerId, code).prefix
        const mediaKeys = (await r2ListKeys(`${prefix}/`)).filter(
          (key) =>
            (key.includes('/media/') || key.includes('/previews/')) &&
            !key.endsWith('.json'),
        )
        await signalModerationScan(mediaKeys)
      } catch {
        // best-effort : le balayage de fond du videur reprendra ces médias.
      }
    }

    return Response.json({ code, status }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'HIKE_STATUS_FAILED',
        message: error instanceof Error ? error.message : 'Mise à jour impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}

// Le propriétaire (ou l'admin) supprime DÉFINITIVEMENT sa carte : retrait du
// registre, coupure du pointeur public si elle était la carte par défaut, et
// effacement de tout son contenu R2 (project.json + médias). Irréversible.
export async function DELETE(request: Request) {
  if (!hasR2Config() || !hasFirebaseAdmin()) {
    return Response.json(
      { message: 'Service indisponible.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  const user = await verifyRequestUser(request)
  if (!user) {
    return Response.json(
      { message: 'Connexion requise.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const body = (await request.json().catch(() => ({}))) as { code?: string }
    const code = body.code?.trim()
    if (!code) {
      return Response.json(
        { message: 'code est obligatoire.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const folder = trailFolder(code)
    const entry = (await readHikeIndex()).find((hike) => hike.folder === folder)
    if (!entry) {
      return Response.json(
        { message: 'Carte introuvable.' },
        { status: 404, headers: jsonHeaders },
      )
    }
    if (entry.ownerId !== user.uid && !isAdminUser(user)) {
      return Response.json(
        { message: 'Cette carte appartient à un autre utilisateur.' },
        { status: 403, headers: jsonHeaders },
      )
    }

    // Retrait du registre + coupure du pointeur public s'il visait cette carte.
    await removeHikeIndex(folder)
    const activeBody = await r2GetText(activeTrailPath)
    if (activeBody) {
      try {
        const active = JSON.parse(activeBody) as { folder?: string }
        if (active?.folder === folder) await r2DeleteObject(activeTrailPath)
      } catch {
        // active.json illisible : on n'y touche pas.
      }
    }

    // Effacement du contenu R2 (project.json + médias) sous le préfixe de la carte.
    await r2DeletePrefix(`${trailLocation(entry.ownerId, code).prefix}/`)

    return Response.json({ code, deleted: true }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json(
      {
        code: 'HIKE_DELETE_FAILED',
        message: error instanceof Error ? error.message : 'Suppression impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
