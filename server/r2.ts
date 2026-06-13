import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const requiredKeys = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_BASE_URL',
] as const

export const hasR2Config = (): boolean => {
  return requiredKeys.every((key) => Boolean(process.env[key]?.trim()))
}

const config = () => {
  if (!hasR2Config()) {
    throw new Error('Configuration Cloudflare R2 incomplete.')
  }

  return {
    accountId: process.env.R2_ACCOUNT_ID!.trim(),
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    bucket: process.env.R2_BUCKET_NAME!.trim(),
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL!.trim().replace(/\/$/, ''),
  }
}

const client = () => {
  const current = config()
  return new S3Client({
    region: 'auto',
    endpoint: `https://${current.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: current.accessKeyId,
      secretAccessKey: current.secretAccessKey,
    },
  })
}

export const r2PublicUrl = (key: string): string => {
  const { publicBaseUrl } = config()
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${publicBaseUrl}/${encodedKey}`
}

export const r2GetText = async (key: string): Promise<string | null> => {
  const { bucket } = config()
  try {
    const result = await client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )
    return result.Body ? await result.Body.transformToString() : null
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode
    if (status === 404) return null
    throw error
  }
}

export const r2PutText = async (
  key: string,
  value: string,
): Promise<string> => {
  const { bucket } = config()
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: value,
      CacheControl: 'no-store',
      ContentType: 'application/json; charset=utf-8',
    }),
  )
  return r2PublicUrl(key)
}

export const r2PrepareUpload = async ({
  key,
  contentType,
}: {
  key: string
  contentType: string
}): Promise<{ alreadyExists: boolean; uploadUrl?: string; url: string }> => {
  const { bucket } = config()
  let alreadyExists = false

  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    alreadyExists = true
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode
    if (status !== 404) throw error
  }

  if (alreadyExists) {
    return { alreadyExists: true, url: r2PublicUrl(key) }
  }

  const uploadUrl = await getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentType: contentType,
    }),
    { expiresIn: 60 * 60 },
  )

  return { alreadyExists: false, uploadUrl, url: r2PublicUrl(key) }
}
