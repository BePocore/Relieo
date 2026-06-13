import { upload } from '@vercel/blob/client'

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
      else reject(new Error(`Envoi refuse (${request.status}).`))
    }
    request.onerror = () => reject(new Error('Connexion interrompue pendant l envoi.'))
    request.send(body)
  })
}

export const uploadMedia = async ({
  file,
  fingerprint,
  adminPassword,
  kind = 'media',
  onProgress,
}: {
  file: File | Blob
  fingerprint: string
  adminPassword: string
  kind?: 'media' | 'preview'
  onProgress?: UploadProgress
}): Promise<{ url: string; alreadyExists: boolean }> => {
  const fileName = file instanceof File ? file.name : `${fingerprint}.jpg`
  const contentType = file.type || 'application/octet-stream'
  const prepareResponse = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': adminPassword,
    },
    body: JSON.stringify({
      type: 'rando3d.prepare-upload',
      fileName,
      contentType,
      fingerprint,
      kind,
    }),
  })

  if (prepareResponse.ok) {
    const prepared = (await prepareResponse.json()) as PreparedUpload
    if (prepared.provider === 'r2') {
      if (!prepared.alreadyExists && prepared.uploadUrl) {
        await putWithProgress(prepared.uploadUrl, file, contentType, onProgress)
      }
      return { url: prepared.url, alreadyExists: prepared.alreadyExists }
    }
  }

  if (prepareResponse.status !== 409) {
    const result = (await prepareResponse.json().catch(() => null)) as {
      message?: string
    } | null
    throw new Error(result?.message ?? 'Preparation de l envoi impossible.')
  }

  const fallbackBody = file instanceof File
    ? file
    : new File([file], fileName, { type: contentType })
  const folder = kind === 'preview' ? 'previews' : 'media'
  const blob = await upload(
    `rando3d/${folder}/${fingerprint}-${fileName}`,
    fallbackBody,
    {
      access: 'public',
      handleUploadUrl: '/api/upload',
      headers: { 'x-admin-password': adminPassword },
      contentType,
      multipart: fallbackBody.size > 10 * 1024 * 1024,
      onUploadProgress: ({ loaded }) => onProgress?.(loaded),
    },
  )
  return { url: blob.url, alreadyExists: false }
}
