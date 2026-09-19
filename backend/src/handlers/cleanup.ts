/**
 * Runs daily. Applies each user's retention:
 *   Starter / free : nothing kept (also clears abandoned uploads older than 1 hour)
 *   Plus           : notes and photos older than 30 days
 *   Pro            : kept while subscribed
 * After a downgrade or cancellation, everything is kept for a 30-day grace period first.
 */
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getBilling, listObjects, listUserIds } from '../lib/account';
import { retentionCutoff } from '../lib/plans';
import { s3, bucket } from '../lib/storage';
import { notePrefix, uploadPrefix } from '../lib/validation';

const HOUR = 3_600_000;

async function purge(prefix: string, cutoff: number): Promise<number> {
  let deleted = 0;
  for await (const obj of listObjects(prefix)) {
    if (!('Key' in obj) || !obj.Key) continue;
    if ((obj.LastModified?.getTime() ?? Date.now()) < cutoff) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: obj.Key }));
      deleted += 1;
    }
  }
  return deleted;
}

export const handler = async () => {
  const now = Date.now();
  let users = 0;
  let deleted = 0;
  for await (const sub of listUserIds()) {
    users += 1;
    try {
      const cutoff = retentionCutoff(await getBilling(sub), now);
      if (cutoff === null) continue;
      deleted += await purge(notePrefix(sub), cutoff);
      deleted += await purge(uploadPrefix(sub), Math.min(cutoff, now - HOUR));
    } catch (err) {
      console.error('Cleanup failed for user', sub, err);
    }
  }
  console.log(JSON.stringify({ users, deleted }));
  return { users, deleted };
};
