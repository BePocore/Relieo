import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { hasAdminPassword, isAdminRequest } from '../server/auth.js'

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
    const body = (await request.json()) as HandleUploadBody

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
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith('rando3d/media/') || pathname.includes('..')) {
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
    const message =
      error instanceof Error ? error.message : 'Envoi du media impossible.'
    return Response.json({ message }, { status: 400 })
  }
}
