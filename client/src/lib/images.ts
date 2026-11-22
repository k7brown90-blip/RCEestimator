/**
 * Client-side image downscale before upload — bytes live in the database, so
 * a 12 MP phone photo gets resized to something the CRM actually needs.
 * Shared by the price-book walkthrough photos, the job photo gallery and the
 * Messages thread's "Add photo" (which uploads the picture itself, not a data URL).
 */

/** The longest side a picture keeps, in pixels. */
export const MAX_PICTURE_SIDE = 1600;

async function scaledCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function downscale(file: File): Promise<string> {
  return (await scaledCanvas(file)).toDataURL("image/jpeg", 0.82);
}

/** The same shrink, as a JPEG file body: what the Messages routes take as a raw `image/jpeg` request. */
export async function downscaleToBlob(file: File): Promise<Blob> {
  const canvas = await scaledCanvas(file);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("That picture could not be read."))), "image/jpeg", 0.82);
  });
}
