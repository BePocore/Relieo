import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import { hasR2Config, R2QuotaError, r2PrepareUpload } from '../server/r2.js'
import { cleanStorageName, trailLocation } from '../server/trailStorage.js'
import { hasFirebaseAdmin, verifyRequestUser } from '../server/firebaseAdmin.js'

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
  type: 'rando3d.prepare-upload'
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
  if (hasFirebaseAdmin()) {
    if (!(await verifyRequestUser(request))) {
      return Response.json({ message: 'Connexion requise.' }, { status: 401 })
    }
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
    if (body.type !== 'rando3d.prepare-upload') {
      return Response.json({ message: 'Requête d’envoi invalide.' }, { status: 400 })
    }

    const fingerprint = body.fingerprint?.replace(/[^a-f0-9]/gi, '')
    const contentType = body.contentType?.trim() || 'application/octet-stream'
    const size = Number(body.size)
    const location = trailLocation(body.trailCode ?? '')

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
    const prepared = await r2PrepareUpload({
      key: `${location.prefix}/${folder}/${suffix}`,
      contentType,
      size,
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
          message: 'Limite de 9,99 Go atteinte. Le fichier n’a pas été enregistré.',
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
