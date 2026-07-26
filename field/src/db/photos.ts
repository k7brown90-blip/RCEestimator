import { db } from './database'

export async function savePhoto(id: string, blob: Blob): Promise<string> {
  await db.photos.add({ id, blob, mimeType: blob.type })
  return id
}

export async function getPhoto(id: string): Promise<Blob | undefined> {
  const record = await db.photos.get(id)
  return record?.blob
}

export async function deletePhoto(id: string): Promise<void> {
  await db.photos.delete(id)
}
