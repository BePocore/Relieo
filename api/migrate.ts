import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import {
  hasR2Config,
  r2CopyPrefix,
  r2DeletePrefix,
  r2GetText,
  r2ListKeys,
  r2PutText,
} from '../server/r2.js'
import {
  activeTrailPath,
  trailLocation,
  type ActiveTrail,
} from '../server/trailStorage.js'
import { hikeIndexPath, type HikeIndexEntry } from '../server/hikeIndex.js'

const jsonHeaders = { 'Cache-Control': 'no-store' }

// Migration one-shot du stockage `rando3d/...` (clé par dossier) vers le schéma
// `relieo/users/<uid>/randonnees/<folder>/...` (clé par propriétaire). Opération
// d'administration, protégée par le mot de passe admin.
//
//   POST /api/migrate                → copie + réécrit (NON destructif)
//   POST /api/migrate?delete=true    → supprime l'ancien `rando3d/` (après vérif)
//
// La phase de copie est idempotente : relancer ne réécrase pas les objets déjà
// copiés (r2CopyObjects ignore les destinations existantes) et réécrit les JSON.
const OLD_ROOT = 'rando3d/'
const OLD_INDEX = 'rando3d/index.json'
const OLD_ACTIVE = 'rando3d/active.json'

const oldFolderPrefix = (folder: string): string =>
  `${OLD_ROOT}randonnees/${folder}/`

// Réécrit l'ancien préfixe de clé par le nouveau partout dans un texte
// (les URLs publiques des médias contiennent ce préfixe de clé R2).
const rewrite = (text: string, oldPrefix: string, newPrefix: string): string =>
  text.split(oldPrefix).join(newPrefix)

export async function POST(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503, headers: jsonHeaders },
    )
  }
  if (!hasAdminPassword() || !isAdminRequest(request)) {
    return Response.json(
      { message: 'Mot de passe admin requis.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const wantsDelete =
      new URL(request.url).searchParams.get('delete') === 'true'

    // Phase 2 : suppression de l'ancien arbre, à lancer SEULEMENT après avoir
    // vérifié que le site charge bien depuis les nouvelles clés.
    if (wantsDelete) {
      const removedKeys = (await r2ListKeys(OLD_ROOT)).length
      await r2DeletePrefix(OLD_ROOT)
      return Response.json(
        { phase: 'delete', removedKeys },
        { headers: jsonHeaders },
      )
    }

    // Phase 1 : copie + réécriture (non destructive, l'ancien reste intact).
    const oldIndexBody = await r2GetText(OLD_INDEX)
    const oldHikes: HikeIndexEntry[] = oldIndexBody
      ? ((JSON.parse(oldIndexBody) as { hikes?: HikeIndexEntry[] }).hikes ?? [])
      : []

    const report: Array<Record<string, unknown>> = []
    const newHikes: HikeIndexEntry[] = []

    for (const hike of oldHikes) {
      if (!hike.ownerId) {
        report.push({ folder: hike.folder, skipped: 'ownerId manquant' })
        newHikes.push(hike)
        continue
      }
      const oldPrefix = oldFolderPrefix(hike.folder)
      const target = trailLocation(hike.ownerId, hike.code)
      const newPrefix = `${target.prefix}/`

      // 1. Copier médias + previews + project.json (doublement temporaire toléré).
      const copiedKeys = await r2CopyPrefix(oldPrefix, newPrefix, {
        skipQuota: true,
      })

      // 2. Réécrire les URLs internes du project.json vers les nouvelles clés.
      const oldProjectText = await r2GetText(`${oldPrefix}project.json`)
      if (oldProjectText) {
        await r2PutText(
          target.projectKey,
          rewrite(oldProjectText, oldPrefix, newPrefix),
          undefined,
          { skipQuota: true },
        )
      }

      // 3. Entrée d'index avec la cover réécrite.
      newHikes.push({
        ...hike,
        coverUrl: hike.coverUrl
          ? rewrite(hike.coverUrl, oldPrefix, newPrefix)
          : hike.coverUrl,
      })
      report.push({ folder: hike.folder, ownerId: hike.ownerId, copiedKeys })
    }

    // 4. Nouveau registre global.
    await r2PutText(hikeIndexPath, JSON.stringify({ hikes: newHikes }), undefined, {
      skipQuota: true,
    })

    // 5. Nouveau pointeur public (rando active) avec la nouvelle clé.
    const oldActiveBody = await r2GetText(OLD_ACTIVE)
    if (oldActiveBody) {
      const oldActive = JSON.parse(oldActiveBody) as ActiveTrail
      const ownerId = newHikes.find(
        (hike) => hike.folder === oldActive.folder,
      )?.ownerId
      if (ownerId) {
        const target = trailLocation(ownerId, oldActive.code)
        await r2PutText(
          activeTrailPath,
          JSON.stringify({ ...target, updatedAt: oldActive.updatedAt }),
          undefined,
          { skipQuota: true },
        )
      }
    }

    return Response.json(
      { phase: 'migrate', migrated: report.length, hikes: report },
      { headers: jsonHeaders },
    )
  } catch (error) {
    return Response.json(
      {
        code: 'MIGRATE_FAILED',
        message: error instanceof Error ? error.message : 'Migration impossible.',
      },
      { status: 500, headers: jsonHeaders },
    )
  }
}
