#!/usr/bin/env tsx
/**
 * validate-frontmatter.ts
 *
 * Enforces:
 * 1. docs/domain/*.md must have `type: domain` frontmatter
 * 2. specs/**\/*.md must have `id: SPEC-NNN` frontmatter
 * 3. Task checklists (- [ ]) not allowed in docs/domain/ files
 * 4. Acceptance criteria patterns not allowed in docs/domain/ files
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();
let errors = 0;

function glob(dir: string, ext: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...glob(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) fm[key.trim()] = rest.join(':').trim();
  }
  return fm;
}

function fail(file: string, message: string): void {
  console.error(`FAIL ${relative(ROOT, file)}: ${message}`);
  errors++;
}

// Rule 1 + 3 + 4: docs/domain/*.md
const domainDir = join(ROOT, 'docs', 'domain');
try {
  const domainFiles = glob(domainDir, '.md');
  for (const file of domainFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);

    if (fm['type'] !== 'domain') {
      fail(file, 'missing `type: domain` frontmatter');
    }
    if (/^- \[ \]/m.test(content)) {
      fail(file, 'task checklists (- [ ]) not allowed in domain docs');
    }
    if (/acceptance criteria/i.test(content)) {
      fail(file, 'acceptance criteria not allowed in domain docs');
    }
  }
} catch {
  // docs/domain/ doesn't exist yet — that's fine
}

// Rule 2: specs/**/*.md must have id: SPEC-NNN
const specsDir = join(ROOT, 'specs');
try {
  const specFiles = glob(specsDir, '.md');
  for (const file of specFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);

    if (!fm['id'] || !/^SPEC-\d+$/.test(fm['id'])) {
      fail(file, 'missing or invalid `id: SPEC-NNN` frontmatter');
    }
  }
} catch {
  // specs/ doesn't exist yet — fine
}

if (errors > 0) {
  console.error(`\n${errors} validation error(s). Fix before committing.`);
  process.exit(1);
} else {
  console.log('Frontmatter validation passed.');
}
