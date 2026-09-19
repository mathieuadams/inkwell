/**
 * GET    /notes        -> { notes: NoteSummary[] }
 * GET    /notes/{id}   -> Note & { imageUrl }
 * PATCH  /notes/{id}   { title?, text? } -> Note
 * DELETE /notes/{id}   -> 204
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { handle, HttpError, json, parseBody, userId } from '../lib/http';
import { bucket, deleteNote, getNote, listNotes, s3, saveNote, toSummary } from '../lib/storage';
import { isNoteId, MAX_TEXT_CHARS } from '../lib/validation';

export const handler = handle(async (event) => {
  const sub = userId(event);

  if (event.routeKey === 'GET /notes') {
    const notes = await listNotes(sub);
    return json(200, { notes: notes.map(toSummary) });
  }

  const id = event.pathParameters?.id;
  if (!isNoteId(id)) throw new HttpError(404, 'Note not found.');
  const note = await getNote(sub, id);

  switch (event.routeKey) {
    case 'GET /notes/{id}': {
      const imageUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket(), Key: note.sourceKey }), {
        expiresIn: 900,
      });
      return json(200, { ...note, imageUrl });
    }

    case 'PATCH /notes/{id}': {
      const body = parseBody<{ title: string; text: string }>(event);
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80) {
          throw new HttpError(400, 'Titles must be 1 to 80 characters.');
        }
        note.title = body.title.trim();
      }
      if (body.text !== undefined) {
        if (typeof body.text !== 'string' || body.text.length > MAX_TEXT_CHARS) {
          throw new HttpError(413, `Text must be under ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`);
        }
        if (body.text !== note.text) {
          note.text = body.text;
          note.translations = {}; // translations no longer match the text
        }
      }
      note.updatedAt = new Date().toISOString();
      await saveNote(sub, note);
      return json(200, note);
    }

    case 'DELETE /notes/{id}':
      await deleteNote(sub, note);
      return { statusCode: 204 };

    default:
      throw new HttpError(404, 'Not found.');
  }
});
