import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import { hasR2Config, r2PrepareUpload } from '../server/r2.js'

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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody | {
      type: 'rando3d.prepare-upload'
      fileName?: string
      contentType?: string
      fingerprint?: string
      kind?: 'media' | 'preview'
    }

    if (body.type === 'rando3d.prepare-upload' && hasR2Config()) {
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

      const fingerprint = body.fingerprint?.replace(/[^a-f0-9]/gi, '')
      const cleanName = (body.fileName ?? 'media')
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const contentType = body.contentType?.trim() || 'application/octet-stream'
      const kind = body.kind === 'preview' ? 'previews' : 'media'

      if (!fingerprint || fingerprint.length < 16) {
        return Response.json({ message: 'Empreinte de fichier invalide.' }, { status: 400 })
      }
      if (!allowedContentTypes.includes(contentType)) {
        return Response.json({ message: 'Type de fichier non autorise.' }, { status: 400 })
      }

      const extension = body.kind === 'preview' ? '.jpg' : `-${cleanName || 'media'}`
      const prepared = await r2PrepareUpload({
        key: `rando3d/${kind}/${fingerprint}${extension}`,
        contentType,
      })
      return Response.json({ provider: 'r2', ...prepared })
    }

    if (body.type === 'rando3d.prepare-upload') {
      return Response.json(
        { message: 'Cloudflare R2 non configure, utilisation de Vercel Blob.' },
        { status: 409 },
      )
    }

    if (body.type === 'blob.generate-client-token') {
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

    const response = await handleUpload({
      request,
      body: body as HandleUploadBody,
      onBeforeGenerateToken: async (pathname) => {
        const allowedPath =
          pathname.startsWith('rando3d/media/') ||
          pathname.startsWith('rando3d/previews/')
        if (!allowedPath || pathname.includes('..')) {
          throw new Error('Chemin de media invalide.')
        }

        return {
          allowedContentTypes,
          maximumSizeInBytes: 2 * 1024 * 1024 * 1024,
          addRandomSuffix: true,
          allowOverwrite: false,
          cacheControlMaxAge: 31_536_000,
        }
      },
    })

    return Response.json(response)
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : 'Envoi du media impossible.'
    const storageBlocked = /403|blocked|suspended|limits/i.test(rawMessage)
    return Response.json(
      {
        code: storageBlocked ? 'STORAGE_SUSPENDED' : 'UPLOAD_FAILED',
        message: storageBlocked
          ? 'Stockage en ligne sature. Aucun fichier local n a ete perdu.'
          : rawMessage,
      },
      { status: storageBlocked ? 503 : 400 },
    )
  }
}
