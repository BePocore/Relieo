type UploadProgress = (loaded: number) => void

type PreparedUpload = {
  provider: 'r2'
  alreadyExists: boolean
  uploadUrl?: string
  url: string
}

type DeletedUpload = {
  deleted: true
}

type CleanupUpload = {
  deletedCount: number
  mediaDeletedCount?: number
  previewDeletedCount?: number
}

const digestToHex = (digest: ArrayBuffer, bytes = 16): string => {
  return Array.from(new Uint8Array(digest))
    .slice(0, bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const legacyFileFingerprint = async (file: File): Promise<string> => {
  const source = `${file.name}\u0000${file.size}\u0000${file.lastModified}`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return digestToHex(digest, 12)
}

const contentFileFingerprint = async (file: File): Promise<string> => {
  const fullHashLimit = 32 * 1024 * 1024
  if (file.size <= fullHashLimit) {
    return digestToHex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  }

  const chunkSize = 2 * 1024 * 1024
  const middleStart = Math.max(Math.floor(file.size / 2 - chunkSize / 2), 0)
  const signature = new TextEncoder().encode(
    `relieo-content-v1\u0000${file.size}\u0000${file.type}\u0000`,
  )
  const sample = await new Blob([
    signature,
    file.slice(0, chunkSize),
    file.slice(middleStart, Math.min(middleStart + chunkSize, file.size)),
    file.slice(Math.max(file.size - chunkSize, 0)),
  ]).arrayBuffer()
  return digestToHex(await crypto.subtle.digest('SHA-256', sample))
}

export const fileFingerprints = async (
  file: File,
): Promise<{ primary: string; all: string[] }> => {
  const [primary, legacy] = await Promise.all([
    contentFileFingerprint(file),
    legacyFileFingerprint(file),
  ])
  return {
    primary,
    all: Array.from(new Set([primary, legacy])),
  }
}

export const fileFingerprint = async (file: File): Promise<string> => {
  return (await fileFingerprints(file)).primary
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
  kind?: 'media' | 'preview' | 'trace'
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

export const deleteUploadedMedia = async ({
  mediaUrl,
  thumbnailUrl,
  adminPassword,
  idToken,
  trailCode,
}: {
  mediaUrl: string
  thumbnailUrl?: string
  adminPassword: string
  idToken?: string
  trailCode: string
}): Promise<void> => {
  if (!trailCode.trim()) {
    throw new Error('Renseigne le code de la carte avant la suppression.')
  }
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
      type: 'relieo.delete-media',
      mediaUrl,
      thumbnailUrl,
      trailCode,
    }),
  })
  const result = (await response.json().catch(() => null)) as
    | (DeletedUpload & { message?: string })
    | null
  if (!response.ok || result?.deleted !== true) {
    throw new Error(result?.message ?? 'Suppression R2 impossible.')
  }
}

export const cleanupUnusedUploadedMedia = async ({
  usedUrls,
  adminPassword,
  idToken,
  trailCode,
}: {
  usedUrls: string[]
  adminPassword: string
  idToken?: string
  trailCode: string
}): Promise<CleanupUpload> => {
  if (!trailCode.trim()) {
    throw new Error('Renseigne le code de la carte avant le nettoyage.')
  }
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
      type: 'relieo.cleanup-unused-media',
      usedUrls,
      trailCode,
    }),
  })
  const result = (await response.json().catch(() => null)) as
    | (CleanupUpload & { message?: string })
    | null
  if (!response.ok || typeof result?.deletedCount !== 'number') {
    throw new Error(result?.message ?? 'Nettoyage R2 impossible.')
  }
  return result
}
