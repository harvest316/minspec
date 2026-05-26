import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseSections,
  hashSection,
  buildSectionHashes,
  mergeFile,
  loadHashes,
  saveHashes,
  type SectionHashes,
} from '../src/lib/merge-refresh';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('merge-refresh', () => {
  describe('parseSections()', () => {
    it('parses preamble when no headings', () => {
      const sections = parseSections('Just some text\nwith lines');
      expect(sections).toHaveLength(1);
      expect(sections[0].heading).toBe('__preamble__');
      expect(sections[0].body).toContain('Just some text');
    });

    it('parses multiple ## headings', () => {
      const content = `# Title

Preamble text

## Section One

Content one

## Section Two

Content two
`;
      const sections = parseSections(content);
      expect(sections).toHaveLength(3);
      expect(sections[0].heading).toBe('__preamble__');
      expect(sections[0].body).toContain('# Title');
      expect(sections[1].heading).toBe('Section One');
      expect(sections[1].body).toContain('Content one');
      expect(sections[2].heading).toBe('Section Two');
      expect(sections[2].body).toContain('Content two');
    });

    it('handles empty sections', () => {
      const content = `## Empty Section

## Another Section

Content here
`;
      const sections = parseSections(content);
      expect(sections).toHaveLength(3); // preamble + 2 sections
      expect(sections[1].heading).toBe('Empty Section');
      expect(sections[1].body.trim()).toBe('');
    });
  });

  describe('hashSection()', () => {
    it('is deterministic — same content same hash', () => {
      const hash1 = hashSection('hello world');
      const hash2 = hashSection('hello world');
      expect(hash1).toBe(hash2);
    });

    it('different content produces different hash', () => {
      const hash1 = hashSection('hello');
      const hash2 = hashSection('world');
      expect(hash1).not.toBe(hash2);
    });

    it('trims whitespace before hashing', () => {
      const hash1 = hashSection('hello  \n\n');
      const hash2 = hashSection('  hello');
      expect(hash1).toBe(hash2);
    });

    it('returns a hex string', () => {
      const hash = hashSection('test');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('buildSectionHashes()', () => {
    it('builds hash map from sections', () => {
      const sections = parseSections('## A\n\nfoo\n\n## B\n\nbar\n');
      const hashes = buildSectionHashes(sections);
      expect(hashes).toHaveProperty('__preamble__');
      expect(hashes).toHaveProperty('A');
      expect(hashes).toHaveProperty('B');
    });
  });

  describe('mergeFile() — T0 invariant tests', () => {
    // Helper: create a simple markdown doc
    const makeDoc = (...sections: [string, string][]) => {
      return sections
        .map(([heading, body]) =>
          heading === '__preamble__' ? body : `## ${heading}\n\n${body}`,
        )
        .join('\n\n')
        .trimEnd() + '\n';
    };

    it('T0: refresh preserves user-edited sections', () => {
      const original = makeDoc(
        ['__preamble__', '# Project'],
        ['Overview', 'Original overview'],
        ['Setup', 'Original setup'],
      );
      const originalSections = parseSections(original);
      const oldHashes = buildSectionHashes(originalSections);

      // User edits the Overview section
      const userEdited = makeDoc(
        ['__preamble__', '# Project'],
        ['Overview', 'My custom overview with details'],
        ['Setup', 'Original setup'],
      );

      // New template has updated Setup
      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['Overview', 'New template overview'],
        ['Setup', 'Updated setup instructions'],
      );

      const { merged } = mergeFile(userEdited, newTemplate, oldHashes);

      // User-edited Overview must be preserved
      expect(merged).toContain('My custom overview with details');
      expect(merged).not.toContain('New template overview');

      // Unmodified Setup gets updated from template
      expect(merged).toContain('Updated setup instructions');
      expect(merged).not.toContain('Original setup');
    });

    it('T0: refresh updates unmodified sections from new template', () => {
      const original = makeDoc(
        ['__preamble__', '# Project'],
        ['Intro', 'Old intro text'],
      );
      const oldHashes = buildSectionHashes(parseSections(original));

      // User did NOT edit — file is identical to original
      const unchanged = original;

      // New template has updated Intro
      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['Intro', 'Brand new intro text'],
      );

      const { merged } = mergeFile(unchanged, newTemplate, oldHashes);
      expect(merged).toContain('Brand new intro text');
      expect(merged).not.toContain('Old intro text');
    });

    it('T0: refresh appends new sections not in existing file', () => {
      const original = makeDoc(
        ['__preamble__', '# Project'],
        ['Existing', 'Existing content'],
      );
      const oldHashes = buildSectionHashes(parseSections(original));

      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['Existing', 'Existing content'],
        ['Brand New Section', 'This is a new section from template'],
      );

      const { merged } = mergeFile(original, newTemplate, oldHashes);
      expect(merged).toContain('## Brand New Section');
      expect(merged).toContain('This is a new section from template');
      // Existing content preserved
      expect(merged).toContain('Existing content');
    });

    it('T0: refresh preserves user-added sections not in template', () => {
      const original = makeDoc(
        ['__preamble__', '# Project'],
        ['Template Section', 'From template'],
      );
      const oldHashes = buildSectionHashes(parseSections(original));

      // User added a custom section
      const userFile = makeDoc(
        ['__preamble__', '# Project'],
        ['Template Section', 'From template'],
        ['My Custom Section', 'My custom content that I added'],
      );

      // New template doesn't include user's custom section
      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['Template Section', 'Updated template content'],
      );

      const { merged } = mergeFile(userFile, newTemplate, oldHashes);
      // User's custom section must be preserved
      expect(merged).toContain('## My Custom Section');
      expect(merged).toContain('My custom content that I added');
      // Template section gets updated (was unmodified)
      expect(merged).toContain('Updated template content');
    });

    it('round-trip: generate → save hashes → no edits → refresh = identical', () => {
      const generated = makeDoc(
        ['__preamble__', '# Project'],
        ['Overview', 'Template overview'],
        ['Setup', 'Template setup'],
        ['Advanced', 'Template advanced'],
      );
      const sections = parseSections(generated);
      const hashes = buildSectionHashes(sections);

      // Refresh with no edits — content should be identical
      const { merged } = mergeFile(generated, generated, hashes);
      // Normalize whitespace for comparison
      expect(merged.trim()).toBe(generated.trim());
    });

    it('handles empty old hashes (first refresh after manual creation)', () => {
      const existing = makeDoc(
        ['__preamble__', '# Project'],
        ['Intro', 'User wrote this manually'],
      );

      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['Intro', 'Template intro'],
        ['New Section', 'From template'],
      );

      // No old hashes — everything gets regenerated from template
      const { merged } = mergeFile(existing, newTemplate, {});
      expect(merged).toContain('Template intro');
      expect(merged).toContain('## New Section');
    });

    it('preserves section ordering: template sections first, then user sections', () => {
      const original = makeDoc(
        ['__preamble__', '# Project'],
        ['A', 'Section A'],
        ['B', 'Section B'],
      );
      const oldHashes = buildSectionHashes(parseSections(original));

      const userFile = makeDoc(
        ['__preamble__', '# Project'],
        ['A', 'Section A'],
        ['B', 'Section B'],
        ['Z-Custom', 'User added this'],
      );

      // Template reorders and adds C
      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['A', 'Updated A'],
        ['C', 'New section C'],
        ['B', 'Updated B'],
      );

      const { merged } = mergeFile(userFile, newTemplate, oldHashes);

      // Template ordering: A, C, B, then user's Z-Custom
      const aIdx = merged.indexOf('## A');
      const cIdx = merged.indexOf('## C');
      const bIdx = merged.indexOf('## B');
      const zIdx = merged.indexOf('## Z-Custom');

      expect(aIdx).toBeLessThan(cIdx);
      expect(cIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(zIdx);
    });

    it('new hashes reflect the merged content', () => {
      const original = makeDoc(
        ['__preamble__', '# Project'],
        ['Sec', 'Original content'],
      );
      const oldHashes = buildSectionHashes(parseSections(original));

      // User edits Sec
      const userEdited = makeDoc(
        ['__preamble__', '# Project'],
        ['Sec', 'User edited content'],
      );

      const newTemplate = makeDoc(
        ['__preamble__', '# Project'],
        ['Sec', 'Template content v2'],
      );

      const { newHashes } = mergeFile(userEdited, newTemplate, oldHashes);

      // Since user edited, their version is kept — hash should match user's content
      expect(newHashes['Sec']).toBe(hashSection('User edited content'));
    });
  });

  describe('loadHashes() / saveHashes()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-hash-test-'));
      fs.mkdirSync(path.join(tmpDir, '.minspec'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty object when file does not exist', () => {
      const hashes = loadHashes(tmpDir);
      expect(hashes).toEqual({});
    });

    it('round-trips hashes through save and load', () => {
      const data = {
        'CLAUDE.md': { __preamble__: 'abc123', Overview: 'def456' },
        'AGENTS.md': { __preamble__: 'ghi789' },
      };
      saveHashes(tmpDir, data);
      const loaded = loadHashes(tmpDir);
      expect(loaded).toEqual(data);
    });

    it('returns empty object for invalid JSON', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.minspec', 'generated-hashes.json'),
        'not json!',
      );
      const hashes = loadHashes(tmpDir);
      expect(hashes).toEqual({});
    });
  });
});
