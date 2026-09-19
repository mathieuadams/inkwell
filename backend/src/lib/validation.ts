import { HttpError } from './http';

export const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const;
export type AllowedType = keyof typeof ALLOWED_TYPES;
export type SourceFormat = 'jpeg' | 'png' | 'webp' | 'pdf';

/** Bedrock Converse limits: images 3.75 MB, documents 4.5 MB. */
export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_PDF_BYTES = 4_500_000;
export const MAX_TEXT_CHARS = 10_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uploadPrefix = (sub: string) => `users/${sub}/uploads/`;
export const notePrefix = (sub: string) => `users/${sub}/notes/`;
export const noteKey = (sub: string, id: string) => `${notePrefix(sub)}${id}.json`;

export const isAllowedType = (v: unknown): v is AllowedType =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(ALLOWED_TYPES, v);

export const maxBytesFor = (type: AllowedType) => (type === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES);

export const isNoteId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function formatFor(contentType: string | undefined): SourceFormat | null {
  switch (contentType) {
    case 'image/jpeg': return 'jpeg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return null;
  }
}

/** Only objects the caller uploaded, e.g. users/{sub}/uploads/{uuid}.jpg */
export function assertOwnedUpload(sub: string, key: unknown): asserts key is string {
  const ok =
    typeof key === 'string' &&
    key.startsWith(uploadPrefix(sub)) &&
    /^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/i.test(key.slice(uploadPrefix(sub).length));
  if (!ok) throw new HttpError(403, 'That upload does not belong to your account.');
}

/** A language name such as "French", "Chinese (Simplified)" or "Português". */
export const isLanguage = (v: unknown): v is string =>
  typeof v === 'string' && /^\p{L}[\p{L} ()\-]{1,39}$/u.test(v);
