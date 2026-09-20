/** POST /translate  { text, target, noteId? } -> { target, text, account } */
import { handle, HttpError, json, parseBody, userId } from '../lib/http';
import { translate } from '../lib/bedrock';
import { getNote, saveNote } from '../lib/storage';
import { getAccount, updateUsage } from '../lib/account';
import { checkAllowance, recordUsage, storesNotes, summary } from '../lib/plans';
import { isLanguage, isNoteId, MAX_TEXT_CHARS } from '../lib/validation';

export const handler = handle(async (event) => {
  const sub = userId(event);
  const { text, target, noteId } = parseBody<{ text: string; target: string; noteId: string }>(event);

  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Add some text to translate.');
  if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, `Text must be under ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters.`);
  if (!isLanguage(target)) throw new HttpError(400, 'Choose a language to translate into.');
  if (noteId !== undefined && noteId !== null && !isNoteId(noteId)) throw new HttpError(400, 'Unknown note.');

  const { billing, usage, credits } = await getAccount(sub);
  const blocked = checkAllowance(billing, usage, 'translation', process.env, credits);
  if (blocked) throw new HttpError(402, blocked);

  // Load first so a bad noteId fails before we spend a model call.
  const note = noteId && storesNotes(billing) ? await getNote(sub, noteId) : null;
  const translated = await translate(text, target);
  const nextUsage = await updateUsage(sub, (u) => recordUsage(billing, u, 'translation'));

  const writes: Promise<unknown>[] = [];
  if (note) {
    const now = new Date().toISOString();
    if (note.text !== text) {
      note.text = text;
      note.translations = {};
    }
    note.translations[target] = { text: translated, updatedAt: now };
    note.updatedAt = now;
    writes.push(saveNote(sub, note));
  }
  await Promise.all(writes);

  return json(200, { target, text: translated, account: summary(billing, nextUsage, process.env, credits) });
});
