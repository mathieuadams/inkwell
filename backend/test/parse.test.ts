import { describe, expect, it } from 'vitest';
import { parseTranscription, parseTranslation } from '../src/lib/parse';

const toolOutput = (input: unknown, stopReason = 'tool_use') =>
  ({
    stopReason,
    output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'save_transcription', input } }] } },
  }) as never;

const textOutput = (text: string) =>
  ({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text }] } } }) as never;

describe('parseTranscription', () => {
  it('reads the tool input', () => {
    const r = parseTranscription(toolOutput({ title: 'Weekend plans', language: 'English', text: 'a\r\nb\n', legible: true }));
    expect(r).toEqual({ title: 'Weekend plans', language: 'English', text: 'a\nb', legible: true });
  });
  it('fills in a missing title and language', () => {
    const r = parseTranscription(toolOutput({ text: 'hello', legible: true }));
    expect(r.title).toBe('Untitled note');
    expect(r.language).toBe('Unknown');
  });
  it('reports illegible notes', () => {
    expect(parseTranscription(toolOutput({ text: '', legible: false })).legible).toBe(false);
  });
  it('explains truncated output to the user', () => {
    expect(() => parseTranscription(toolOutput({}, 'max_tokens'))).toThrow(/one page at a time/);
  });
  it('fails on an unexpected shape', () => {
    expect(() => parseTranscription(textOutput('hi'))).toThrow(/Unexpected/);
  });
});

describe('parseTranslation', () => {
  it('returns trimmed text without note tags', () => {
    expect(parseTranslation(textOutput('<note>\nBonjour\n</note>'))).toBe('Bonjour');
    expect(parseTranslation(textOutput('  Hola  '))).toBe('Hola');
  });
  it('fails on empty output', () => {
    expect(() => parseTranslation(textOutput('   '))).toThrow(/Empty/);
  });
});
