import { describe, expect, it } from 'vitest';
import {
  AVATAR_ACCESSORIES,
  AVATAR_EYES,
  AVATAR_PALETTES,
  AVATAR_SHAPES,
  contrastRatio,
  generate,
  PACKAGE_NAME,
  PALETTES,
  partsKey,
  resolveParts,
  shuffle,
  type AvatarParams,
} from './index.js';

const seeds = (count: number) => Array.from({ length: count }, (_, i) => `seed-${i}`);

describe('@openbot/avatars', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@openbot/avatars');
  });

  it('has the catalogue the plan asks for', () => {
    expect(AVATAR_SHAPES).toEqual(expect.arrayContaining(['circle', 'rounded', 'blob', 'bean']));
    expect(AVATAR_PALETTES.length).toBeGreaterThanOrEqual(8);
    expect(AVATAR_EYES.length).toBeGreaterThanOrEqual(4);
    expect([...AVATAR_ACCESSORIES].sort()).toEqual(
      ['antenna', 'glasses', 'hat', 'headphones', 'none', 'scarf'].sort(),
    );
  });
});

describe('generate', () => {
  it('is deterministic: the same seed gives the same SVG string', () => {
    for (const seed of seeds(20)) {
      expect(generate({ seed }).svg).toBe(generate({ seed }).svg);
    }
    expect(generate({ seed: 'ada' })).toMatchInlineSnapshot(
      { svg: expect.any(String), colors: expect.any(Object) },
      `
      {
        "accessory": "hat",
        "colors": Any<Object>,
        "eyes": "pill",
        "palette": "rose",
        "seed": "ada",
        "shape": "bean",
        "svg": Any<String>,
      }
    `,
    );
  });

  it('honours pinned parts without disturbing the others', () => {
    const base = resolveParts({ seed: 'grace' });
    const shape = AVATAR_SHAPES.find((s) => s !== base.shape)!;
    expect(resolveParts({ seed: 'grace', shape })).toEqual({ ...base, shape });
    expect(resolveParts({ seed: 'grace', kind: 'generated', palette: 'sun', eyes: 'dot' })).toEqual(
      {
        ...base,
        palette: 'sun',
        eyes: 'dot',
      },
    );
  });

  it('falls back to the seed for unknown part names', () => {
    expect(resolveParts({ seed: 'grace', shape: 'hexagon' })).toEqual(
      resolveParts({ seed: 'grace' }),
    );
  });

  it('never puts params text into the markup', () => {
    const { svg } = generate({ seed: '<script>alert(1)</script>', shape: '"><script>' });
    expect(svg).not.toContain('script');
  });

  it('spreads 200 seeds across every part value', () => {
    const drawn = seeds(200).map((seed) => resolveParts({ seed }));
    for (const [part, values] of [
      ['shape', AVATAR_SHAPES],
      ['palette', AVATAR_PALETTES],
      ['eyes', AVATAR_EYES],
      ['accessory', AVATAR_ACCESSORIES],
    ] as const) {
      expect(new Set(drawn.map((d) => d[part]))).toEqual(new Set(values));
    }
    // 2,160 combinations, so a few birthday collisions among 200 random seeds
    // are expected (about nine pairs); shuffle() below is what guarantees
    // distinct avatars within a roster.
    expect(new Set(drawn.map(partsKey)).size).toBeGreaterThanOrEqual(185);
  });
});

describe('shuffle', () => {
  it('returns new, reproducible params with different parts', () => {
    const next = shuffle('ada');
    expect(next.kind).toBe('generated');
    expect(next.seed).not.toBe('ada');
    expect(shuffle('ada')).toEqual(next);
    expect(partsKey(resolveParts(next))).not.toBe(partsKey(resolveParts({ seed: 'ada' })));
  });

  it('gives a 200-avatar roster with no two alike by parts', () => {
    const roster: AvatarParams[] = [];
    let seed = 'roster';
    for (let i = 0; i < 200; i++) {
      const next = shuffle(seed, roster);
      roster.push(next);
      seed = next.seed;
    }
    expect(new Set(roster.map((p) => p.seed)).size).toBe(200);
    expect(new Set(roster.map((p) => partsKey(resolveParts(p)))).size).toBe(200);
  });
});

describe('palettes', () => {
  it.each(Object.entries(PALETTES))('%s has enough contrast to read at 24 px', (_, p) => {
    // Pupils and eye lines on the body, and on the whites.
    expect(contrastRatio(p.eye, p.body)).toBeGreaterThanOrEqual(4);
    expect(contrastRatio(p.eye, p.sclera)).toBeGreaterThanOrEqual(7);
    // Whites and accessories against the body: WCAG non-text contrast where it matters.
    expect(contrastRatio(p.sclera, p.body)).toBeGreaterThanOrEqual(1.8);
    expect(contrastRatio(p.accent, p.body)).toBeGreaterThanOrEqual(3);
  });
});
