import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  normalizeFullName,
  REPO_FULL_NAME,
  rescueBranchName,
  RESCUE_BRANCH_PREFIX,
} from './git.js';
import { skillSlug, skillSummary } from './skills.js';

// Names this package derives from what a person typed: each ends up in a
// URL, a path or a git ref, so its shape must hold for any input.

describe('skillSlug', () => {
  it('is a short lowercase slug for any name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (name) => {
        const slug = skillSlug(name);
        expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(slug.length).toBeLessThanOrEqual(48);
      }),
    );
  });

  it('leaves a slug as it is', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (name) => {
        const slug = skillSlug(name);
        expect(skillSlug(slug)).toBe(slug);
      }),
    );
  });
});

describe('skillSummary', () => {
  it('is one line no longer than the limit', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 2, max: 400 }), (content, max) => {
        const summary = skillSummary(content, max);
        expect(summary.length).toBeLessThanOrEqual(max);
        expect(summary).not.toContain('\n');
        expect(summary).toBe(summary.trim());
      }),
    );
  });
});

describe('normalizeFullName', () => {
  it('returns a repository name that is safe in a path, or null', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'Z', '0', '.', '/', '-', '_', ' ', 'g', 'i', 't') }),
        (raw) => {
          const name = normalizeFullName(raw);
          if (name === null) return;
          expect(name).toMatch(REPO_FULL_NAME);
          const [owner, repo, ...rest] = name.split('/');
          expect(rest).toEqual([]);
          for (const part of [owner, repo]) expect(part).not.toMatch(/^\.+$/);
        },
      ),
    );
  });

  it('keeps a valid name, with or without spaces and `.git` around it', () => {
    const part = fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/);
    fc.assert(
      fc.property(part, part, (owner, repo) => {
        const name = `${owner}/${repo}`;
        expect(normalizeFullName(name)).toBe(name);
        expect(normalizeFullName(`  ${name}.git `)).toBe(name);
      }),
    );
  });
});

describe('rescueBranchName', () => {
  const date = fc.date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2999-12-31T23:59:59Z'),
    noInvalidDate: true,
  });

  it('is a git ref with no character git refuses', () => {
    fc.assert(
      fc.property(date, (when) => {
        const name = rescueBranchName(when);
        expect(name.startsWith(RESCUE_BRANCH_PREFIX)).toBe(true);
        expect(name).toMatch(/^openbots\/rescue\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
      }),
    );
  });

  it('sorts by name in the order the rescues happened', () => {
    fc.assert(
      fc.property(date, date, (a, b) => {
        const [first, second] = a <= b ? [a, b] : [b, a];
        expect(rescueBranchName(first) <= rescueBranchName(second)).toBe(true);
      }),
    );
  });
});
