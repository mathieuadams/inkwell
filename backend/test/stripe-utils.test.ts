import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { encodeForm, verifyStripeSignature } from '../src/lib/stripe-utils';

describe('encodeForm', () => {
  it('uses Stripe bracket notation', () => {
    const body = encodeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 1 }],
      subscription_data: { metadata: { sub: 'abc' } },
      skip: undefined,
    });
    expect(decodeURIComponent(body)).toBe(
      'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[metadata][sub]=abc',
    );
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const payload = '{"id":"evt_1"}';
  const t = 1_800_000_000;
  const sign = (body: string, ts = t, key = secret) =>
    `t=${ts},v1=${createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')}`;

  it('accepts a valid signature', () => {
    expect(verifyStripeSignature(payload, sign(payload), secret, 300, t + 10)).toBe(true);
  });
  it('accepts when any of several v1 signatures matches', () => {
    expect(verifyStripeSignature(payload, `${sign(payload)},v1=deadbeef`, secret, 300, t)).toBe(true);
  });
  it('rejects tampering, wrong secrets, old timestamps and junk', () => {
    expect(verifyStripeSignature('{"id":"evt_2"}', sign(payload), secret, 300, t)).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload, t, 'whsec_other'), secret, 300, t)).toBe(false);
    expect(verifyStripeSignature(payload, sign(payload), secret, 300, t + 301)).toBe(false);
    expect(verifyStripeSignature(payload, undefined, secret)).toBe(false);
    expect(verifyStripeSignature(payload, 'garbage', secret)).toBe(false);
  });
});
