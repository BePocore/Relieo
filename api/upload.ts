import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import {
  hasR2Config,
  R2QuotaError,
  r2PrepareUpload,
  type StorageScope,
} from '../server/r2.js'
import { cleanStorageName, STUDIO_OWNER, trailLocation } from '../server/trailStorage.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'
import { userStorageScope } from '../server/userStorage.js'
import { formatBytes } from '../server/format.js'

const allowedContentTypes = [
  'application/octet-stream',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
]

type PrepareUploadBody = {
  type: 'relieo.prepare-upload'
  fileName?: string
  contentType?: string
  fingerprint?: string
  kind?: 'media' | 'preview'
  size?: number
  trailCode?: string
}

export async function POST(request: Request) {
  if (!hasR2Config()) {
    return Response.json(
      { message: 'Cloudflare R2 n’est pas configuré.' },
      { status: 503 },
    )
  }
  // Auth : jeton Firebase si configuré, sinon mot de passe admin (compat).
  let uid: string | null = null
  if (hasFirebaseAdmin()) {
    const user = await verifyRequestUser(request)
    if (!user) {
      return Response.json({ message: 'Connexion requise.' }, { status: 401 })
    }
    uid = user.uid
  } else {
    if (!hasAdminPassword()) {
      return Response.json(
        { message: 'RANDO3D_ADMIN_PASSWORD manque dans Vercel.' },
        { status: 503 },
      )
    }
    if (!isAdminRequest(request)) {
      return Response.json(
        { message: 'Mot de passe Studio incorrect.' },
        { status: 401 },
      )
    }
  }

  try {
    const body = (await request.json()) as PrepareUploadBody
    if (body.type !== 'relieo.prepare-upload') {
      return Response.json({ message: 'Requête d’envoi invalide.' }, { status: 400 })
    }

    const fingerprint = body.fingerprint?.replace(/[^a-f0-9]/gi, '')
    const contentType = body.contentType?.trim() || 'application/octet-stream'
    const size = Number(body.size)
    // Le dossier de la rando est rangé sous le préfixe du propriétaire prouvé
    // (uid Firebase), ou sous le namespace `_studio` pour le repli mot de passe
    // admin. Impossible donc d'écrire dans le dossier d'un autre utilisateur.
    const owner = uid ?? STUDIO_OWNER
    const location = trailLocation(owner, body.trailCode ?? '')

    if (!fingerprint || fingerprint.length < 16) {
      return Response.json({ message: 'Empreinte de fichier invalide.' }, { status: 400 })
    }
    if (!allowedContentTypes.includes(contentType)) {
      return Response.json({ message: 'Type de fichier non autorisé.' }, { status: 400 })
    }
    if (!Number.isSafeInteger(size) || size <= 0) {
      return Response.json({ message: 'Taille de fichier invalide.' }, { status: 400 })
    }

    const folder = body.kind === 'preview' ? 'previews' : 'media'
    const fileName = cleanStorageName(body.fileName ?? 'media')
    const suffix = body.kind === 'preview' ? `${fingerprint}.jpg` : `${fingerprint}-${fileName}`
    // Quota par utilisateur (5 Go) si on connaît son uid ; sinon repli global.
    const scope: StorageScope | undefined = uid
      ? userStorageScope(uid)
      : undefined
    const prepared = await r2PrepareUpload({
      key: `${location.prefix}/${folder}/${suffix}`,
      contentType,
      size,
      scope,
    })
    return Response.json({ provider: 'r2', folder: location.folder, ...prepared })
  } catch (error) {
    if (error instanceof R2QuotaError) {
      return Response.json(
        {
          code: error.code,
          limitBytes: error.limitBytes,
          requestedBytes: error.requestedBytes,
          usedBytes: error.usedBytes,
          message: `Limite de ${formatBytes(error.limitBytes)} atteinte pour votre forfait. Le fichier n’a pas été enregistré.`,
        },
        { status: 413 },
      )
    }
    return Response.json(
      {
        code: 'UPLOAD_FAILED',
        message: error instanceof Error ? error.message : 'Envoi R2 impossible.',
      },
      { status: 400 },
    )
  }
}
