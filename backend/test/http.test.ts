import { describe, expect, it, vi } from 'vitest';
import { handle, HttpError, parseBody, userId, type ApiEvent } from '../src/lib/http';

const SUB = '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';
const event = (over: Partial<ApiEvent> = {}, sub: unknown = SUB) =>
  ({ requestContext: { authorizer: { jwt: { claims: { sub }, scopes: [] } } }, ...over }) as unknown as ApiEvent;

describe('userId', () => {
  it('reads the verified sub claim', () => expect(userId(event())).toBe(SUB));
  it('rejects a missing or malformed sub', () => {
    expect(() => userId(event({}, undefined))).toThrow(HttpError);
    expect(() => userId(event({}, '../admin'))).toThrow(HttpError);
  });
});

describe('parseBody', () => {
  it('parses JSON and base64 JSON', () => {
    expect(parseBody(event({ body: '{"a":1}' }))).toEqual({ a: 1 });
    expect(parseBody(event({ body: Buffer.from('{"a":2}').toString('base64'), isBase64Encoded: true }))).toEqual({ a: 2 });
  });
  it('rejects empty, invalid and non-object bodies', () => {
    expect(() => parseBody(event())).toThrow(/empty/);
    expect(() => parseBody(event({ body: '{nope' }))).toThrow(/JSON object/);
    expect(() => parseBody(event({ body: '[1]' }))).toThrow(/JSON object/);
  });
});

describe('handle', () => {
  it('maps HttpError to its status and message', async () => {
    const res = await handle(async () => { throw new HttpError(413, 'Too big'); })(event());
    expect(res).toMatchObject({ statusCode: 413, body: JSON.stringify({ error: 'Too big' }) });
  });
  it('hides internal errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handle(async () => { throw new Error('secret detail'); })(event());
    expect(res).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(res)).not.toContain('secret');
    spy.mockRestore();
  });
});
