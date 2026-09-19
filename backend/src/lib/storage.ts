import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type _Object,
} from '@aws-sdk/client-s3';
import { HttpError, requireEnv } from './http';
import { isNoteId, noteKey, notePrefix, uploadPrefix } from './validation';

/**
 * WHEN_REQUIRED keeps presigned PUT URLs free of SDK-added checksum
 * parameters, which browsers can't satisfy.
 */
export const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export const bucket = () => requireEnv('BUCKET');

export interface Translation {
  text: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  title: string;
  language: string;
  text: string;
  sourceKey: string;
  sourceType: string;
  createdAt: string;
  updatedAt: string;
  translations: Record<string, Translation>;
}

export interface NoteSummary {
  id: string;
  title: string;
  language: string;
  preview: string;
  translations: string[];
  createdAt: string;
  updatedAt: string;
}

export const toSummary = (n: Note): NoteSummary => ({
  id: n.id,
  title: n.title,
  language: n.language,
  preview: n.text.slice(0, 140),
  translations: Object.keys(n.translations ?? {}),
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

export async function getNote(sub: string, id: string): Promise<Note> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: noteKey(sub, id) }));
    return JSON.parse(await res.Body!.transformToString()) as Note;
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') throw new HttpError(404, 'Note not found.');
    throw err;
  }
}

export async function saveNote(sub: string, note: Note): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: noteKey(sub, note.id),
      Body: JSON.stringify(note),
      ContentType: 'application/json',
    }),
  );
}

export async function listNotes(sub: string, limit = 25): Promise<Note[]> {
  const prefix = notePrefix(sub);
  const objects: _Object[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    objects.push(...(res.Contents ?? []));
    token = res.NextContinuationToken;
  } while (token && objects.length < 5000);

  const ids = objects
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
    .map((o) => (o.Key ?? '').slice(prefix.length).replace(/\.json$/, ''))
    .filter(isNoteId)
    .slice(0, limit);

  const notes = await Promise.all(ids.map((id) => getNote(sub, id).catch(() => null)));
  return notes.filter((n): n is Note => n !== null);
}

export async function deleteNote(sub: string, note: Note): Promise<void> {
  const keys = [noteKey(sub, note.id)];
  if (note.sourceKey?.startsWith(uploadPrefix(sub))) keys.push(note.sourceKey);
  await Promise.all(keys.map((Key) => s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key }))));
}
