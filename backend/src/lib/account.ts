import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command, type _Object } from '@aws-sdk/client-s3';
import { s3, bucket } from './storage';
import { newBilling, newCredits, newUsage, type Billing, type Credits, type Usage } from './plans';

// billing.json is written only by billing/webhook code; usage.json only by extract/translate,
// so concurrent writers never overwrite each other's fields.
const billingKey = (sub: string) => `users/${sub}/billing.json`;
const usageKey = (sub: string) => `users/${sub}/usage.json`;
const creditsKey = (sub: string) => `users/${sub}/credits.json`; // written only by the webhook

async function readJson<T>(key: string, fallback: () => T): Promise<T> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return { ...fallback(), ...JSON.parse(await res.Body!.transformToString()) };
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return fallback();
    throw err;
  }
}

const writeJson = (key: string, value: unknown) =>
  s3.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: JSON.stringify(value), ContentType: 'application/json' }));

export const getBilling = (sub: string) => readJson<Billing>(billingKey(sub), newBilling);
export const saveBilling = (sub: string, b: Billing) => writeJson(billingKey(sub), b);
export const getUsage = (sub: string) => readJson<Usage>(usageKey(sub), newUsage);
export const saveUsage = (sub: string, u: Usage) => writeJson(usageKey(sub), u);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Atomic read-modify-write of usage.json using S3 conditional writes (If-Match / If-None-Match),
 * so pages converted in parallel (batch upload) are all counted.
 */
export async function updateUsage(sub: string, change: (u: Usage) => Usage): Promise<Usage> {
  const Key = usageKey(sub);
  for (let attempt = 0; attempt < 8; attempt++) {
    let current = newUsage();
    let etag: string | undefined;
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key }));
      etag = res.ETag;
      current = { ...newUsage(), ...JSON.parse(await res.Body!.transformToString()) };
    } catch (err) {
      if ((err as { name?: string }).name !== 'NoSuchKey') throw err;
    }
    const next = change(current);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket(),
          Key,
          Body: JSON.stringify(next),
          ContentType: 'application/json',
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
        }),
      );
      return next;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = e.$metadata?.httpStatusCode;
      const conflict = status === 412 || status === 409 || e.name === 'PreconditionFailed' || e.name === 'ConditionalRequestConflict';
      if (!conflict) throw err;
      await sleep(40 * 2 ** attempt + Math.random() * 40);
    }
  }
  throw new Error(`Could not update usage for ${sub} after retries`);
}
export const getCredits = (sub: string) => readJson<Credits>(creditsKey(sub), newCredits);
export const saveCredits = (sub: string, c: Credits) => writeJson(creditsKey(sub), c);

/** Everything quota checks need, read in parallel. */
export async function getAccount(sub: string) {
  const [billing, usage, credits] = await Promise.all([getBilling(sub), getUsage(sub), getCredits(sub)]);
  return { billing, usage, credits };
}

export async function* listObjects(prefix: string, delimiter?: string): AsyncGenerator<_Object | { Prefix: string }> {
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }),
    );
    for (const p of res.CommonPrefixes ?? []) if (p.Prefix) yield { Prefix: p.Prefix };
    for (const o of res.Contents ?? []) yield o;
    token = res.NextContinuationToken;
  } while (token);
}

export async function* listUserIds(): AsyncGenerator<string> {
  for await (const entry of listObjects('users/', '/')) {
    if ('Prefix' in entry && entry.Prefix) yield entry.Prefix.slice('users/'.length, -1);
  }
}
