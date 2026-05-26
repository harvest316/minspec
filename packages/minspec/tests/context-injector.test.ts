import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildContextBlock,
  injectContext,
  removeContext,
  injectContextToFile,
  removeContextFromFile,
  type ActiveSpecContext,
} from '../src/lib/context-injector';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BLOCK_START = '<!-- minspec:active-spec:start -->';
const BLOCK_END = '<!-- minspec:active-spec:end -->';

const sampleContext: ActiveSpecContext = {
  specId: 'SPEC-001',
  title: 'User Authentication',
  tier: 'T3',
  currentPhase: 'implement',
  status: 'implementing',
};

const minimalContext: ActiveSpecContext = {
  specId: 'SPEC-002',
  title: 'Fix typo',
  tier: 'T1',
  currentPhase: null,
  status: 'new',
};

describe('buildContextBlock()', () => {
  it('includes spec metadata in table format', () => {
    const block = buildContextBlock(sampleContext);
    expect(block).toContain(BLOCK_START);
    expect(block).toContain(BLOCK_END);
    expect(block).toContain('SPEC-001');
    expect(block).toContain('User Authentication');
    expect(block).toContain('T3');
    expect(block).toContain('implementing');
    expect(block).toContain('implement');
  });

  it('omits current phase row when null', () => {
    const block = buildContextBlock(minimalContext);
    expect(block).toContain('SPEC-002');
    expect(block).not.toContain('Current Phase');
  });

  it('includes file allowlist when provided', () => {
    const ctx: ActiveSpecContext = {
      ...sampleContext,
      fileAllowlist: ['src/auth.ts', 'tests/auth.test.ts'],
    };
    const block = buildContextBlock(ctx);
    expect(block).toContain('`src/auth.ts`');
    expect(block).toContain('`tests/auth.test.ts`');
    expect(block).toContain('File allowlist');
  });

  it('omits file allowlist section when empty', () => {
    const block = buildContextBlock(sampleContext);
    expect(block).not.toContain('File allowlist');
  });
});

describe('injectContext()', () => {
  it('injects into empty file content', () => {
    const result = injectContext('', sampleContext);
    expect(result).toContain(BLOCK_START);
    expect(result).toContain(BLOCK_END);
    expect(result).toContain('SPEC-001');
  });

  it('appends to existing content with separator', () => {
    const existing = '# My Project\n\nSome content here.';
    const result = injectContext(existing, sampleContext);
    expect(result).toContain('# My Project');
    expect(result).toContain('Some content here.');
    expect(result).toContain(BLOCK_START);
    // Check there's a blank line between existing content and block
    expect(result).toContain('Some content here.\n\n' + BLOCK_START);
  });

  it('replaces existing block on update', () => {
    const first = injectContext('# Project\n\nContent.', sampleContext);
    expect(first).toContain('SPEC-001');

    const updated = injectContext(first, { ...sampleContext, specId: 'SPEC-999', title: 'Updated' });
    expect(updated).toContain('SPEC-999');
    expect(updated).toContain('Updated');
    // Old spec ID should be gone
    expect(updated).not.toContain('SPEC-001');
    // User content preserved
    expect(updated).toContain('# Project');
    expect(updated).toContain('Content.');
  });

  it('preserves user content outside markers after multiple cycles', () => {
    let content = '# Config\n\nUser rules here.\n\n## Other Section\n\nMore stuff.';

    // Inject first spec
    content = injectContext(content, sampleContext);
    expect(content).toContain('SPEC-001');
    expect(content).toContain('User rules here.');
    expect(content).toContain('More stuff.');

    // Update to different spec
    content = injectContext(content, minimalContext);
    expect(content).toContain('SPEC-002');
    expect(content).not.toContain('SPEC-001');
    expect(content).toContain('User rules here.');
    expect(content).toContain('More stuff.');

    // Update again
    content = injectContext(content, { ...sampleContext, specId: 'SPEC-003' });
    expect(content).toContain('SPEC-003');
    expect(content).not.toContain('SPEC-002');
    expect(content).toContain('User rules here.');
    expect(content).toContain('More stuff.');
  });

  it('handles content that has markers but no valid block (edge case)', () => {
    // Start marker but no end marker — treat as no block exists
    const content = `# File\n\nSome text\n\n${BLOCK_START}\nbroken block`;
    const result = injectContext(content, sampleContext);
    // Should still end up with a valid block
    expect(result).toContain(BLOCK_START);
    expect(result).toContain(BLOCK_END);
    expect(result).toContain('SPEC-001');
  });
});

describe('removeContext()', () => {
  it('removes an injected block', () => {
    const withBlock = injectContext('# Project\n\nContent.', sampleContext);
    expect(withBlock).toContain(BLOCK_START);

    const cleaned = removeContext(withBlock);
    expect(cleaned).not.toContain(BLOCK_START);
    expect(cleaned).not.toContain(BLOCK_END);
    expect(cleaned).not.toContain('SPEC-001');
    expect(cleaned).toContain('# Project');
    expect(cleaned).toContain('Content.');
  });

  it('returns content unchanged when no block exists', () => {
    const content = '# Just a file\n\nNo block here.';
    expect(removeContext(content)).toBe(content);
  });

  it('returns empty string when content was only the block', () => {
    const block = buildContextBlock(sampleContext);
    const result = removeContext(block);
    expect(result).toBe('');
  });
});

describe('file operations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minspec-ctx-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injectContextToFile creates file if missing', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    injectContextToFile(filePath, sampleContext);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('SPEC-001');
    expect(content).toContain(BLOCK_START);
  });

  it('injectContextToFile updates existing file preserving content', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# My Claude Config\n\nDon\'t touch this.\n');

    injectContextToFile(filePath, sampleContext);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('My Claude Config');
    expect(content).toContain('Don\'t touch this.');
    expect(content).toContain('SPEC-001');
  });

  it('removeContextFromFile cleans up block from file', () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, '# Config\n\nContent.\n');
    injectContextToFile(filePath, sampleContext);

    removeContextFromFile(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).not.toContain(BLOCK_START);
    expect(content).toContain('# Config');
  });

  it('removeContextFromFile is no-op when file does not exist', () => {
    const filePath = path.join(tmpDir, 'nonexistent.md');
    removeContextFromFile(filePath); // Should not throw
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('creates parent directories if needed', () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'file.md');
    injectContextToFile(filePath, sampleContext);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('SPEC-001');
  });
});
