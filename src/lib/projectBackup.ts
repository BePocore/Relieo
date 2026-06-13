import type { TrailProject } from '../types'

const databaseName = 'rando3d-local'
const storeName = 'projects'
const latestKey = 'latest'

const openDatabase = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export const loadLocalProject = async (): Promise<TrailProject | null> => {
  if (!('indexedDB' in window)) return null
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(latestKey)
    request.onsuccess = () => resolve((request.result as TrailProject) ?? null)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

export const saveLocalProject = async (project: TrailProject): Promise<void> => {
  if (!('indexedDB' in window)) return
  const database = await openDatabase()

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).put(project, latestKey)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })

  database.close()
}
