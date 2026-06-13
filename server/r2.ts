import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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

export const R2_STORAGE_LIMIT_BYTES = 9_990_000_000

export class R2QuotaError extends Error {
  readonly code = 'R2_QUOTA_EXCEEDED'
  readonly limitBytes = R2_STORAGE_LIMIT_BYTES
  readonly requestedBytes: number
  readonly usedBytes: number

  constructor(usedBytes: number, requestedBytes: number) {
    const remainingBytes = Math.max(R2_STORAGE_LIMIT_BYTES - usedBytes, 0)
    super(
      `Limite Cloudflare atteinte : ${remainingBytes} octets disponibles, ${requestedBytes} octets demandes.`,
    )
    this.name = 'R2QuotaError'
    this.usedBytes = usedBytes
    this.requestedBytes = requestedBytes
  }
}

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

const objectSize = async (key: string): Promise<number> => {
  const { bucket } = config()
  try {
    const result = await client().send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    )
    return result.ContentLength ?? 0
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode
    if (status === 404) return 0
    throw error
  }
}

export const r2StorageUsage = async (): Promise<number> => {
  const { bucket } = config()
  let continuationToken: string | undefined
  let totalBytes = 0

  do {
    const page = await client().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    )
    totalBytes += (page.Contents ?? []).reduce(
      (sum, object) => sum + (object.Size ?? 0),
      0,
    )
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined
  } while (continuationToken)

  return totalBytes
}

const assertStorageCapacity = async ({
  incomingBytes,
  replacedBytes = 0,
}: {
  incomingBytes: number
  replacedBytes?: number
}): Promise<{ limitBytes: number; usedBytes: number }> => {
  const usedBytes = await r2StorageUsage()
  const projectedBytes = usedBytes - replacedBytes + incomingBytes
  if (projectedBytes > R2_STORAGE_LIMIT_BYTES) {
    throw new R2QuotaError(Math.max(usedBytes - replacedBytes, 0), incomingBytes)
  }
  return { limitBytes: R2_STORAGE_LIMIT_BYTES, usedBytes }
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
  const incomingBytes = new TextEncoder().encode(value).byteLength
  const replacedBytes = await objectSize(key)
  await assertStorageCapacity({ incomingBytes, replacedBytes })
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
  size,
}: {
  key: string
  contentType: string
  size: number
}): Promise<{
  alreadyExists: boolean
  limitBytes: number
  uploadUrl?: string
  url: string
  usedBytes: number
}> => {
  const { bucket } = config()
  const existingSize = await objectSize(key)
  const alreadyExists = existingSize > 0

  if (alreadyExists) {
    const usedBytes = await r2StorageUsage()
    return {
      alreadyExists: true,
      limitBytes: R2_STORAGE_LIMIT_BYTES,
      url: r2PublicUrl(key),
      usedBytes,
    }
  }

  const quota = await assertStorageCapacity({ incomingBytes: size })

  const uploadUrl = await getSignedUrl(
    client(),
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentLength: size,
      ContentType: contentType,
    }),
    { expiresIn: 60 * 60 },
  )

  return {
    alreadyExists: false,
    ...quota,
    uploadUrl,
    url: r2PublicUrl(key),
  }
}
