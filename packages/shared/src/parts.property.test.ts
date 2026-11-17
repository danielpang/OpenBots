import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyMessageDelta, parseMentions, type MessageDelta, type MessagePart } from './parts.js';

// Streaming (plan 5.5): a client applies whatever deltas reach it, replays
// included, and must end with the text the server stored.

/** `text` cut into pieces at generated places. */
const chunked = fc.tuple(fc.string(), fc.array(fc.nat(), { maxLength: 8 })).map(([text, cuts]) => {
  const at = [...new Set(cuts.map((cut) => cut % (text.length + 1)))].sort((a, b) => a - b);
  const pieces = [0, ...at].map((start, i) => text.slice(start, at[i] ?? text.length));
  return { text, pieces };
});

const textDeltas = (pieces: string[]): MessageDelta[] =>
  pieces.map((text, i) => ({
    deltaSeq: i + 1,
    deltas: [{ partIndex: 0, type: 'text', text }],
  }));

const apply = (deltas: MessageDelta[]) =>
  deltas.reduce((state, delta) => applyMessageDelta(state.parts, state.deltaSeq, delta), {
    parts: [] as MessagePart[],
    deltaSeq: 0,
  });

describe('applyMessageDelta', () => {
  it('builds the same text however the stream was cut', () => {
    fc.assert(
      fc.property(chunked, ({ text, pieces }) => {
        const { parts, deltaSeq } = apply(textDeltas(pieces));
        expect(parts).toEqual([{ type: 'text', text }]);
        expect(deltaSeq).toBe(pieces.length);
      }),
    );
  });

  it('ignores a delta it has already applied', () => {
    fc.assert(
      fc.property(chunked, fc.nat(), ({ pieces }, pick) => {
        const deltas = textDeltas(pieces);
        const once = apply(deltas);
        const replayed = applyMessageDelta(
          once.parts,
          once.deltaSeq,
          deltas[pick % deltas.length]!,
        );
        expect(replayed).toEqual(once);
      }),
    );
  });

  it('reaches the same parts when a reconnect replays an earlier stretch', () => {
    fc.assert(
      fc.property(chunked, fc.nat(), fc.nat(), ({ pieces }, a, b) => {
        const deltas = textDeltas(pieces);
        const from = a % deltas.length;
        const to = from + (b % (deltas.length - from)) + 1;
        const replay = [...deltas.slice(0, to), ...deltas.slice(from)];
        expect(apply(replay)).toEqual(apply(deltas));
      }),
    );
  });

  it('never changes the parts it was given', () => {
    fc.assert(
      fc.property(chunked, ({ pieces }) => {
        const deltas = textDeltas(pieces);
        const before = apply(deltas.slice(0, -1));
        const snapshot = structuredClone(before.parts);
        applyMessageDelta(before.parts, before.deltaSeq, deltas.at(-1)!);
        expect(before.parts).toEqual(snapshot);
      }),
    );
  });
});

describe('parseMentions', () => {
  it('returns lowercase handles, each once, and never `everyone`', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('@', 'a', 'B', '-', '_', ' ', '.', '1') }),
        (text) => {
          const { handles } = parseMentions(text);
          expect(new Set(handles).size).toBe(handles.length);
          for (const handle of handles) {
            expect(handle).toMatch(/^[a-z0-9_-]{1,32}$/);
            expect(handle).not.toBe('everyone');
          }
        },
      ),
    );
  });

  it('finds every handle written as its own word', () => {
    const handle = fc.stringMatching(/^[a-z0-9]{1,12}$/).filter((h) => h !== 'everyone');
    fc.assert(
      fc.property(fc.uniqueArray(handle, { minLength: 1, maxLength: 5 }), (handles) => {
        const text = handles.map((h) => `hello @${h}, `).join('');
        expect(parseMentions(text)).toEqual({ handles, everyone: false });
        expect(parseMentions(text.toUpperCase()).handles).toEqual(handles);
      }),
    );
  });
});
