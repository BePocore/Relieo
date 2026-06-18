type GoogleTokenResponse = {
  access_token?: string
  error?: string
  error_description?: string
}

type GoogleTokenClient = {
  callback: (response: GoogleTokenResponse) => void
  requestAccessToken: (options: { prompt?: 'consent' | '' }) => void
}

type GoogleAccounts = {
  oauth2: {
    initTokenClient: (config: {
      client_id: string
      scope: string
      callback: (response: GoogleTokenResponse) => void
    }) => GoogleTokenClient
  }
}

type PickerView = {
  setMimeTypes: (mimeTypes: string) => PickerView
}

type PickerBuilder = {
  enableFeature: (feature: unknown) => PickerBuilder
  setDeveloperKey: (key: string) => PickerBuilder
  setAppId: (appId: string) => PickerBuilder
  setOAuthToken: (token: string) => PickerBuilder
  addView: (view: unknown) => PickerBuilder
  setCallback: (callback: (data: PickerData) => void) => PickerBuilder
  build: () => { setVisible: (visible: boolean) => void }
}

type PickerNamespace = {
  View: new (viewId: string) => PickerView
  ViewId: { DOCS: string }
  Feature: {
    NAV_HIDDEN: unknown
    MULTISELECT_ENABLED: unknown
    SUPPORT_DRIVES?: unknown
  }
  Action: { PICKED: string; CANCEL: string }
  Response: { DOCUMENTS: string }
  Document: { ID: string; NAME: string; MIME_TYPE: string }
  PickerBuilder: new () => PickerBuilder
}

type GapiGlobal = {
  load: (features: string, callback: () => void) => void
}

type PickerData = {
  action?: string
  [key: string]: unknown
}

type DrivePickedFile = {
  id: string
  name?: string
  mimeType?: string
}

type DriveFileMetadata = {
  id?: string
  name?: string
  mimeType?: string
  size?: string
}

declare global {
  interface Window {
    gapi?: GapiGlobal
    google?: {
      accounts?: GoogleAccounts
      picker?: PickerNamespace
    }
  }
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_MIME_TYPES = [
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
].join(',')

const scriptPromises = new Map<string, Promise<void>>()

const googleDriveConfig = () => ({
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY?.trim() ?? '',
  appId: import.meta.env.VITE_GOOGLE_APP_ID?.trim() ?? '',
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? '',
})

export const googleDriveImportConfigured = (): boolean => {
  const config = googleDriveConfig()
  return Boolean(config.apiKey && config.appId && config.clientId)
}

const requireGoogleDriveConfig = () => {
  const config = googleDriveConfig()
  if (!config.apiKey || !config.appId || !config.clientId) {
    throw new Error(
      'Google Drive n’est pas configuré. Ajoute VITE_GOOGLE_API_KEY, VITE_GOOGLE_CLIENT_ID et VITE_GOOGLE_APP_ID.',
    )
  }
  return config
}

const loadScript = (
  id: string,
  src: string,
  isReady: () => boolean,
): Promise<void> => {
  if (isReady()) return Promise.resolve()
  const pending = scriptPromises.get(id)
  if (pending) return pending

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null
    const script = existing ?? document.createElement('script')
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Chargement Google Drive trop long. Réessaie.'))
    }, 15_000)

    const cleanup = () => {
      window.clearTimeout(timeout)
      script.removeEventListener('load', handleLoad)
      script.removeEventListener('error', handleError)
    }
    const handleLoad = () => {
      cleanup()
      if (isReady()) resolve()
      else reject(new Error('Bibliothèque Google Drive indisponible.'))
    }
    const handleError = () => {
      cleanup()
      reject(new Error('Impossible de charger Google Drive.'))
    }

    script.addEventListener('load', handleLoad)
    script.addEventListener('error', handleError)
    if (!existing) {
      script.id = id
      script.src = src
      script.async = true
      script.defer = true
      document.head.append(script)
    }
  }).finally(() => {
    scriptPromises.delete(id)
  })

  scriptPromises.set(id, promise)
  return promise
}

const loadGoogleIdentity = async (): Promise<GoogleAccounts> => {
  await loadScript(
    'relieo-google-identity',
    'https://accounts.google.com/gsi/client',
    () => Boolean(window.google?.accounts?.oauth2),
  )
  const accounts = window.google?.accounts
  if (!accounts) throw new Error('Authentification Google indisponible.')
  return accounts
}

const loadGooglePicker = async (): Promise<PickerNamespace> => {
  await loadScript(
    'relieo-google-api',
    'https://apis.google.com/js/api.js',
    () => Boolean(window.gapi),
  )

  await new Promise<void>((resolve) => {
    window.gapi?.load('picker', resolve)
  })

  const picker = window.google?.picker
  if (!picker) throw new Error('Sélecteur Google Drive indisponible.')
  return picker
}

const requestAccessToken = async (
  accounts: GoogleAccounts,
  clientId: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const tokenClient = accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ??
                response.error ??
                'Autorisation Google Drive refusée.',
            ),
          )
          return
        }
        resolve(response.access_token)
      },
    })
    tokenClient.requestAccessToken({ prompt: 'consent' })
  })

const stringValue = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

const pickedFilesFromData = (
  picker: PickerNamespace,
  data: PickerData,
): DrivePickedFile[] => {
  const documents = data[picker.Response.DOCUMENTS]
  if (!Array.isArray(documents)) return []

  return documents
    .map((document): DrivePickedFile | null => {
      if (!document || typeof document !== 'object') return null
      const record = document as Record<string, unknown>
      const id = stringValue(record, picker.Document.ID)
      if (!id) return null
      return {
        id,
        name: stringValue(record, picker.Document.NAME),
        mimeType: stringValue(record, picker.Document.MIME_TYPE),
      }
    })
    .filter((file): file is DrivePickedFile => file !== null)
}

const openPicker = async (
  picker: PickerNamespace,
  config: ReturnType<typeof requireGoogleDriveConfig>,
  accessToken: string,
): Promise<DrivePickedFile[]> =>
  new Promise((resolve) => {
    const view = new picker.View(picker.ViewId.DOCS).setMimeTypes(
      DRIVE_MIME_TYPES,
    )
    const builder = new picker.PickerBuilder()
      .enableFeature(picker.Feature.NAV_HIDDEN)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOAuthToken(accessToken)
      .addView(view)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          resolve(pickedFilesFromData(picker, data))
        } else if (data.action === picker.Action.CANCEL) {
          resolve([])
        }
      })

    if (picker.Feature.SUPPORT_DRIVES) {
      builder.enableFeature(picker.Feature.SUPPORT_DRIVES)
    }

    builder.build().setVisible(true)
  })

const fetchDriveJson = async (
  id: string,
  accessToken: string,
): Promise<DriveFileMetadata> => {
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size',
    supportsAllDrives: 'true',
  })
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) {
    throw new Error(`Lecture Google Drive impossible (${response.status}).`)
  }
  return (await response.json()) as DriveFileMetadata
}

const fetchDriveBlob = async (
  id: string,
  accessToken: string,
): Promise<Blob> => {
  const params = new URLSearchParams({
    alt: 'media',
    supportsAllDrives: 'true',
  })
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) {
    throw new Error(
      `Téléchargement Google Drive impossible (${response.status}).`,
    )
  }
  return response.blob()
}

const downloadDriveFile = async (
  picked: DrivePickedFile,
  accessToken: string,
): Promise<File> => {
  const metadata = await fetchDriveJson(picked.id, accessToken)
  const mimeType = metadata.mimeType ?? picked.mimeType ?? ''
  if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
    throw new Error(
      `${metadata.name ?? picked.name ?? 'Fichier Drive'} n’est pas une photo ou vidéo.`,
    )
  }

  const blob = await fetchDriveBlob(picked.id, accessToken)
  const name = metadata.name ?? picked.name ?? `drive-${picked.id}`
  return new File([blob], name, {
    type: mimeType || blob.type || 'application/octet-stream',
    lastModified: Date.now(),
  })
}

export const pickGoogleDriveMedia = async (): Promise<File[]> => {
  const config = requireGoogleDriveConfig()
  const [accounts, picker] = await Promise.all([
    loadGoogleIdentity(),
    loadGooglePicker(),
  ])
  const accessToken = await requestAccessToken(accounts, config.clientId)
  const pickedFiles = await openPicker(picker, config, accessToken)
  const files: File[] = []

  for (const pickedFile of pickedFiles) {
    files.push(await downloadDriveFile(pickedFile, accessToken))
  }

  return files
}
