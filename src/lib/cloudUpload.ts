type UploadProgress = (loaded: number) => void

type PreparedUpload = {
  provider: 'r2'
  alreadyExists: boolean
  uploadUrl?: string
  url: string
}

export const fileFingerprint = async (file: File): Promise<string> => {
  const source = `${file.name}\u0000${file.size}\u0000${file.lastModified}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const putWithProgress = (
  uploadUrl: string,
  body: Blob,
  contentType: string,
  onProgress?: UploadProgress,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', uploadUrl)
    request.setRequestHeader('Content-Type', contentType)
    request.upload.onprogress = (event) => onProgress?.(event.loaded)
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve()
      else reject(new Error(`Envoi R2 refusé (${request.status}).`))
    }
    request.onerror = () => reject(new Error('Connexion interrompue pendant l’envoi R2.'))
    request.send(body)
  })
}

export const uploadMedia = async ({
  file,
  fingerprint,
  adminPassword,
  idToken,
  trailCode,
  kind = 'media',
  onProgress,
}: {
  file: File | Blob
  fingerprint: string
  adminPassword: string
  idToken?: string
  trailCode: string
  kind?: 'media' | 'preview'
  onProgress?: UploadProgress
}): Promise<{ url: string; alreadyExists: boolean }> => {
  if (!trailCode.trim()) {
    throw new Error('Renseigne le code de la carte avant l’import.')
  }
  const fileName = file instanceof File ? file.name : `${fingerprint}.jpg`
  const contentType = file.type || 'application/octet-stream'
  // Jeton Firebase prioritaire ; repli sur le mot de passe admin (compat).
  const authHeader: Record<string, string> = idToken
    ? { Authorization: `Bearer ${idToken}` }
    : { 'x-admin-password': adminPassword }
  const response = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader,
    },
    body: JSON.stringify({
      type: 'relieo.prepare-upload',
      fileName,
      contentType,
      fingerprint,
      kind,
      size: file.size,
      trailCode,
    }),
  })
  const result = (await response.json().catch(() => null)) as
    | (PreparedUpload & { message?: string })
    | null
  if (!response.ok || result?.provider !== 'r2') {
    throw new Error(result?.message ?? 'Préparation de l’envoi R2 impossible.')
  }
  if (!result.alreadyExists && result.uploadUrl) {
    await putWithProgress(result.uploadUrl, file, contentType, onProgress)
  }
  return { url: result.url, alreadyExists: result.alreadyExists }
}
