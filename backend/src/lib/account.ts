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
