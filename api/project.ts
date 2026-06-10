import { get, put } from '@vercel/blob'
import { hasAdminPassword, isAdminRequest } from '../server/auth.js'

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
    const message =
      error instanceof Error ? error.message : 'Lecture de la carte impossible.'
    return Response.json({ message }, { status: 500, headers: jsonHeaders })
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

    const blob = await put(projectPath, body, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: 'application/json',
    })

    return Response.json(
      { savedAt: new Date().toISOString(), url: blob.url },
      { headers: jsonHeaders },
    )
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Sauvegarde en ligne impossible.'
    return Response.json({ message }, { status: 500, headers: jsonHeaders })
  }
}
