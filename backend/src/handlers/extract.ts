/** POST /extract  { key } -> Note & { saved, account }  (reads the upload with Bedrock; saves it if the plan keeps notes) */
import { randomUUID } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { handle, HttpError, json, parseBody, userId } from '../lib/http';
import { s3, bucket, saveNote, type Note } from '../lib/storage';
import { getAccount, updateUsage } from '../lib/account';
import { checkAllowance, recordUsage, storesNotes, summary } from '../lib/plans';
import { transcribe } from '../lib/bedrock';
import { assertOwnedUpload, formatFor, MAX_IMAGE_BYTES, MAX_PDF_BYTES } from '../lib/validation';

export const handler = handle(async (event) => {
  const sub = userId(event);
  const { key } = parseBody<{ key: string }>(event);
  assertOwnedUpload(sub, key);

  const { billing, usage, credits } = await getAccount(sub);
  const blocked = checkAllowance(billing, usage, 'page', process.env, credits);
  if (blocked) throw new HttpError(402, blocked);

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
    throw new HttpError(422, 'No readable handwriting found. Try a sharper photo in good light, taken straight on.');
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

  const saved = storesNotes(billing);
  const [nextUsage] = await Promise.all([
    updateUsage(sub, (u) => recordUsage(billing, u, 'page')),
    saved
      ? saveNote(sub, note)
      : s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key })).catch((e) => console.warn('Upload delete failed', e)),
  ]);

  return json(201, { ...note, saved, account: summary(billing, nextUsage, process.env, credits) });
});
