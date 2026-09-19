/** POST /uploads  { contentType, size } -> { key, url }  (presigned S3 PUT, 5 min) */
import { randomUUID } from 'crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { handle, HttpError, json, parseBody, userId } from '../lib/http';
import { s3, bucket } from '../lib/storage';
import { getBilling, getUsage } from '../lib/account';
import { checkAllowance } from '../lib/plans';
import { ALLOWED_TYPES, isAllowedType, maxBytesFor, uploadPrefix } from '../lib/validation';

export const handler = handle(async (event) => {
  const sub = userId(event);
  const { contentType, size } = parseBody<{ contentType: string; size: number }>(event);

  if (!isAllowedType(contentType)) throw new HttpError(415, 'Use a JPG, PNG, WebP photo or a PDF.');
  const max = maxBytesFor(contentType);
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > max) {
    throw new HttpError(413, `Files must be under ${(max / 1_000_000).toFixed(1)} MB.`);
  }

  // Fail fast before the user uploads a photo they can't convert.
  const [billing, usage] = await Promise.all([getBilling(sub), getUsage(sub)]);
  const blocked = checkAllowance(billing, usage, 'page');
  if (blocked) throw new HttpError(402, blocked);

  const key = `${uploadPrefix(sub)}${randomUUID()}.${ALLOWED_TYPES[contentType]}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: 300, signableHeaders: new Set(['content-type', 'content-length']) },
  );

  return json(200, { key, url });
});
