/** POST /extract  { key } -> Note   (reads the upload with Bedrock and saves a note) */
import { randomUUID } from 'crypto';
import { GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { handle, HttpError, json, parseBody, userId } from '../lib/http';
import { s3, bucket, saveNote, type Note } from '../lib/storage';
import { transcribe } from '../lib/bedrock';
import { assertOwnedUpload, formatFor, MAX_IMAGE_BYTES, MAX_PDF_BYTES } from '../lib/validation';

export const handler = handle(async (event) => {
  const sub = userId(event);
  const { key } = parseBody<{ key: string }>(event);
  assertOwnedUpload(sub, key);

  let obj: GetObjectCommandOutput;
  try {
    obj = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') throw new HttpError(404, 'Upload not found. Add the photo again.');
    throw err;
  }

  const format = formatFor(obj.ContentType);
  if (!format) throw new HttpError(415, 'Use a JPG, PNG, WebP photo or a PDF.');
  const max = format === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if ((obj.ContentLength ?? 0) > max) throw new HttpError(413, 'That file is too large to read.');

  const bytes = await obj.Body!.transformToByteArray();
  const result = await transcribe(bytes, format);
  if (!result.legible || !result.text) {
    throw new HttpError(422, "No readable handwriting found. Try a sharper photo in good light, taken straight on.");
  }

  const now = new Date().toISOString();
  const note: Note = {
    id: randomUUID(),
    title: result.title,
    language: result.language,
    text: result.text,
    sourceKey: key,
    sourceType: obj.ContentType!,
    createdAt: now,
    updatedAt: now,
    translations: {},
  };
  await saveNote(sub, note);
  return json(201, note);
});
