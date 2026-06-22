import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
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

// Plafond global du bucket (filet de sécurité Cloudflare). Les quotas réels
// sont appliqués par utilisateur via un `StorageScope` (voir plus bas) ; ce
// plafond reste le garde-fou ultime du bucket entier.
export const R2_STORAGE_LIMIT_BYTES = 9_990_000_000

// Portée d'un contrôle de quota :
// - `limitBytes` : la limite à ne pas dépasser.
// - `usagePrefixes` : si défini, l'usage est calculé en sommant ces préfixes
//   (quota par utilisateur). Sinon, l'usage est celui du bucket entier (global).
export type StorageScope = {
  limitBytes: number
  usagePrefixes?: string[]
}

const GLOBAL_SCOPE: StorageScope = { limitBytes: R2_STORAGE_LIMIT_BYTES }

export class R2QuotaError extends Error {
  readonly code = 'R2_QUOTA_EXCEEDED'
  readonly limitBytes: number
  readonly requestedBytes: number
  readonly usedBytes: number

  constructor(usedBytes: number, requestedBytes: number, limitBytes: number) {
    const remainingBytes = Math.max(limitBytes - usedBytes, 0)
    super(
      `Limite de stockage atteinte : ${remainingBytes} octets disponibles, ${requestedBytes} octets demandes.`,
    )
    this.name = 'R2QuotaError'
    this.limitBytes = limitBytes
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

// Octets utilisés sous un ou plusieurs préfixes (quota par utilisateur =
// l'ensemble de ses dossiers de randonnées). Les préfixes en double sont
// dédupliqués pour ne pas compter deux fois le même dossier.
export const r2UsageForPrefixes = async (
  prefixes: string[],
): Promise<number> => {
  const unique = Array.from(new Set(prefixes.filter(Boolean)))
  if (unique.length === 0) return 0
  const sizes = await Promise.all(
    unique.map(async (prefix) => {
      const { bucket } = config()
      let continuationToken: string | undefined
      let total = 0
      do {
        const page = await client().send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        total += (page.Contents ?? []).reduce(
          (sum, object) => sum + (object.Size ?? 0),
          0,
        )
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined
      } while (continuationToken)
      return total
    }),
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

const usageForScope = async (scope: StorageScope): Promise<number> => {
  return scope.usagePrefixes
    ? r2UsageForPrefixes(scope.usagePrefixes)
    : r2StorageUsage()
}

const assertStorageCapacity = async ({
  incomingBytes,
  replacedBytes = 0,
  scope = GLOBAL_SCOPE,
}: {
  incomingBytes: number
  replacedBytes?: number
  scope?: StorageScope
}): Promise<{ limitBytes: number; usedBytes: number }> => {
  const usedBytes = await usageForScope(scope)
  const projectedBytes = usedBytes - replacedBytes + incomingBytes
  if (projectedBytes > scope.limitBytes) {
    throw new R2QuotaError(
      Math.max(usedBytes - replacedBytes, 0),
      incomingBytes,
      scope.limitBytes,
    )
  }
  return { limitBytes: scope.limitBytes, usedBytes }
}

export const r2PublicUrl = (key: string): string => {
  const { publicBaseUrl } = config()
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${publicBaseUrl}/${encodedKey}`
}

// Domaine du « videur » (Cloudflare Worker) qui sert les médias sous contrôle
// d'accès. Les URLs renvoyées au public pointent dessus (cf. rewriteMediaUrls).
const MEDIA_BASE_URL_DEFAULT = 'https://media.relieo.fr'
export const mediaBaseUrl = (): string =>
  process.env.MEDIA_BASE_URL?.trim().replace(/\/$/, '') || MEDIA_BASE_URL_DEFAULT

// Réécrit À LA LECTURE les URLs publiques R2 (…r2.dev) vers media.relieo.fr.
// Réversible : ne modifie pas les fichiers stockés, seulement la réponse servie.
export const rewriteMediaUrls = (text: string): string => {
  const { publicBaseUrl } = config()
  const media = mediaBaseUrl()
  if (!publicBaseUrl || publicBaseUrl === media) return text
  return text.split(publicBaseUrl).join(media)
}

export const r2KeyFromPublicUrl = (url: string): string | null => {
  const { publicBaseUrl } = config()
  // On accepte l'ancienne base publique (r2.dev) ET le domaine du videur
  // (media.relieo.fr) : une carte rechargée peut porter l'une ou l'autre, et la
  // sauvegarde Studio doit pouvoir reconvertir les deux en clé R2.
  for (const base of [publicBaseUrl, mediaBaseUrl()]) {
    const prefix = `${base}/`
    if (!url.startsWith(prefix)) continue
    try {
      return url.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    } catch {
      return null
    }
  }
  return null
}

export const r2ObjectExists = async (key: string): Promise<boolean> => {
  return (await objectSize(key)) > 0
}

export const r2CopyObject = async (
  sourceKey: string,
  destinationKey: string,
): Promise<void> => {
  await r2CopyObjects([{ sourceKey, destinationKey }])
}

export const r2CopyObjects = async (
  objects: Array<{ sourceKey: string; destinationKey: string }>,
  // `skipQuota` n'est utilisé que par la migration d'administration : une copie
  // interne double temporairement le stockage sans être une vraie croissance,
  // donc le plafond global ne doit pas la bloquer.
  options?: { skipQuota?: boolean },
): Promise<void> => {
  const { bucket } = config()
  const unique = Array.from(
    new Map(
      objects
        .filter(({ sourceKey, destinationKey }) => sourceKey !== destinationKey)
        .map((item) => [item.destinationKey, item]),
    ).values(),
  )
  const pending = (
    await Promise.all(
      unique.map(async (item) => ({
        ...item,
        destinationExists: await r2ObjectExists(item.destinationKey),
        sourceSize: await objectSize(item.sourceKey),
      })),
    )
  ).filter((item) => !item.destinationExists)

  const missing = pending.find((item) => item.sourceSize <= 0)
  if (missing) throw new Error(`Fichier R2 introuvable : ${missing.sourceKey}`)
  const incomingBytes = pending.reduce((sum, item) => sum + item.sourceSize, 0)
  if (incomingBytes > 0 && !options?.skipQuota) {
    await assertStorageCapacity({ incomingBytes })
  }

  for (const { sourceKey, destinationKey } of pending) {
    await client().send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        Key: destinationKey,
      }),
    )
  }
}

export const r2DeleteObject = async (key: string): Promise<void> => {
  const { bucket } = config()
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export const r2ListKeys = async (prefix: string): Promise<string[]> => {
  const { bucket } = config()
  let continuationToken: string | undefined
  const keys: string[] = []
  do {
    const page = await client().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    keys.push(
      ...(page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key)),
    )
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined
  } while (continuationToken)
  return keys
}

// Comme r2ListKeys mais renvoie aussi la taille (octets) de chaque objet. Sert au
// diagnostic des médias cassés (taille 0/quasi nulle = upload incomplet).
export const r2ListObjects = async (
  prefix: string,
): Promise<Array<{ key: string; size: number }>> => {
  const { bucket } = config()
  let continuationToken: string | undefined
  const objects: Array<{ key: string; size: number }> = []
  do {
    const page = await client().send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    for (const object of page.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 })
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined
  } while (continuationToken)
  return objects
}

export const r2CopyPrefix = async (
  sourcePrefix: string,
  destinationPrefix: string,
  options?: { skipQuota?: boolean },
): Promise<number> => {
  const keys = await r2ListKeys(sourcePrefix)
  await r2CopyObjects(
    keys.map((sourceKey) => ({
      sourceKey,
      destinationKey: `${destinationPrefix}${sourceKey.slice(sourcePrefix.length)}`,
    })),
    options,
  )
  return keys.length
}

export const r2DeletePrefix = async (prefix: string): Promise<void> => {
  const { bucket } = config()
  const keys = await r2ListKeys(prefix)
  for (let index = 0; index < keys.length; index += 1000) {
    const chunk = keys.slice(index, index + 1000)
    if (chunk.length === 0) continue
    await client().send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    )
  }
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
  scope?: StorageScope,
  options?: { skipQuota?: boolean },
): Promise<string> => {
  const { bucket } = config()
  if (!options?.skipQuota) {
    const incomingBytes = new TextEncoder().encode(value).byteLength
    const replacedBytes = await objectSize(key)
    await assertStorageCapacity({ incomingBytes, replacedBytes, scope })
  }
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
  scope,
}: {
  key: string
  contentType: string
  size: number
  scope?: StorageScope
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
    const usedBytes = await usageForScope(scope ?? GLOBAL_SCOPE)
    return {
      alreadyExists: true,
      limitBytes: scope?.limitBytes ?? R2_STORAGE_LIMIT_BYTES,
      url: r2PublicUrl(key),
      usedBytes,
    }
  }

  const quota = await assertStorageCapacity({ incomingBytes: size, scope })

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
