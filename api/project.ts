import { get, put } from '@vercel/blob'
import { hasAdminPassword, isAdminRequest } from '../server/auth.js'
import { hasR2Config, R2QuotaError, r2GetText, r2PutText } from '../server/r2.js'

const projectPath = 'rando3d/project.json'

const jsonHeaders = {
  'Cache-Control': 'no-store',
}

const isProjectPayload = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false

  const project = value as Record<string, unknown>
  return Array.isArray(project.track) && Array.isArray(project.points)
}

export async function GET() {
  try {
    if (hasR2Config()) {
      const body = await r2GetText(projectPath)
      if (!body) {
        return Response.json(
          { message: 'Aucune carte en ligne enregistree.' },
          { status: 404, headers: jsonHeaders },
        )
      }
      return new Response(body, {
        headers: { ...jsonHeaders, 'Content-Type': 'application/json' },
      })
    }

    const blob = await get(projectPath, {
      access: 'public',
    })

    if (!blob) {
      return Response.json(
        { message: 'Aucune carte en ligne enregistree.' },
        { status: 404, headers: jsonHeaders },
      )
    }

    const project = await new Response(blob.stream).json()
    return Response.json(project, { headers: jsonHeaders })
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : 'Lecture de la carte impossible.'
    const storageBlocked = /403|blocked|suspended|limits/i.test(rawMessage)
    return Response.json(
      {
        code: storageBlocked ? 'STORAGE_SUSPENDED' : 'STORAGE_READ_FAILED',
        message: storageBlocked
          ? 'Stockage en ligne sature. La copie locale reste disponible dans le Studio.'
          : rawMessage,
      },
      { status: storageBlocked ? 503 : 500, headers: jsonHeaders },
    )
  }
}

export async function PUT(request: Request) {
  if (!hasAdminPassword()) {
    return Response.json(
      { message: 'RANDO3D_ADMIN_PASSWORD manque dans Vercel.' },
      { status: 503, headers: jsonHeaders },
    )
  }

  if (!isAdminRequest(request)) {
    return Response.json(
      { message: 'Mot de passe Studio incorrect.' },
      { status: 401, headers: jsonHeaders },
    )
  }

  try {
    const project = (await request.json()) as unknown
    if (!isProjectPayload(project)) {
      return Response.json(
        { message: 'Donnees de carte invalides.' },
        { status: 400, headers: jsonHeaders },
      )
    }

    const body = JSON.stringify(project)
    if (body.length > 10_000_000) {
      return Response.json(
        { message: 'La carte depasse la taille maximale autorisee.' },
        { status: 413, headers: jsonHeaders },
      )
    }

    const url = hasR2Config()
      ? await r2PutText(projectPath, body)
      : (
          await put(projectPath, body, {
            access: 'public',
            addRandomSuffix: false,
            allowOverwrite: true,
            cacheControlMaxAge: 60,
            contentType: 'application/json',
          })
        ).url

    return Response.json(
      {
        provider: hasR2Config() ? 'r2' : 'vercel-blob',
        savedAt: new Date().toISOString(),
        url,
      },
      { headers: jsonHeaders },
    )
  } catch (error) {
    if (error instanceof R2QuotaError) {
      return Response.json(
        {
          code: error.code,
          message: 'Limite de 9,99 Go atteinte. La copie locale du projet est conservee.',
        },
        { status: 413, headers: jsonHeaders },
      )
    }
    const rawMessage =
      error instanceof Error ? error.message : 'Sauvegarde en ligne impossible.'
    const storageBlocked = /403|blocked|suspended|limits/i.test(rawMessage)
    return Response.json(
      {
        code: storageBlocked ? 'STORAGE_SUSPENDED' : 'STORAGE_WRITE_FAILED',
        message: storageBlocked
          ? 'Stockage en ligne sature. La copie locale a ete conservee.'
          : rawMessage,
      },
      { status: storageBlocked ? 503 : 500, headers: jsonHeaders },
    )
  }
}
