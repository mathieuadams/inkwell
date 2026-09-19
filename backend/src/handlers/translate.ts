/** POST /translate  { text, target, noteId? } -> { target, text } */
import { handle, HttpError, json, parseBody, userId } from '../lib/http';
import { translate } from '../lib/bedrock';
import { getNote, saveNote } from '../lib/storage';
import { isLanguage, isNoteId, MAX_TEXT_CHARS } from '../lib/validation';

export const handler = handle(async (event) => {
  const sub = userId(event);
  const { text, target, noteId } = parseBody<{ text: string; target: string; noteId: string }>(event);

  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Add some text to translate.');
  if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, `Text must be under ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`);
  if (!isLanguage(target)) throw new HttpError(400, 'Choose a language to translate into.');
  if (noteId !== undefined && !isNoteId(noteId)) throw new HttpError(400, 'Unknown note.');

  // Load first so a bad noteId fails before we spend a model call.
  const note = noteId ? await getNote(sub, noteId) : null;
  const translated = await translate(text, target);

  if (note) {
    const now = new Date().toISOString();
    if (note.text !== text) {
      note.text = text;
      note.translations = {};
    }
    note.translations[target] = { text: translated, updatedAt: now };
    note.updatedAt = now;
    await saveNote(sub, note);
  }

  return json(200, { target, text: translated });
});
