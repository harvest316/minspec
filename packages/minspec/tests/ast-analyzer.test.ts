import { describe, it, expect } from 'vitest';
import { analyzeAstSignals, type AnalyzableFile, type ClassificationSignal } from '../src/lib/ast-analyzer';

/** Helper: find a signal by name */
function findSignal(signals: ClassificationSignal[], name: string): ClassificationSignal | undefined {
  return signals.find(s => s.name === name);
}

describe('analyzeAstSignals()', () => {
  // --- Graceful fallback / edge cases ---

  describe('graceful fallback', () => {
    it('returns empty signals for empty input', async () => {
      const signals = await analyzeAstSignals([]);
      expect(signals).toEqual([]);
    });

    it('returns empty signals for null-ish input', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signals = await analyzeAstSignals(null as any);
      expect(signals).toEqual([]);
    });

    it('returns empty signals for undefined input', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signals = await analyzeAstSignals(undefined as any);
      expect(signals).toEqual([]);
    });

    it('skips files with empty content', async () => {
      const signals = await analyzeAstSignals([
        { path: 'src/foo.ts', content: '' },
      ]);
      expect(signals).toEqual([]);
    });

    it('skips null file entries', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const signals = await analyzeAstSignals([null as any, undefined as any]);
      expect(signals).toEqual([]);
    });

    it('returns empty signals for unsupported file types', async () => {
      const signals = await analyzeAstSignals([
        { path: 'README.md', content: '# Hello world\n\nexport const foo = 1;' },
        { path: 'image.png', content: 'binary data' },
        { path: 'config.yaml', content: 'key: value' },
      ]);
      expect(signals).toEqual([]);
    });

    it('does not crash on file with null content', async () => {
      const signals = await analyzeAstSignals([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { path: 'src/foo.ts', content: null as any },
      ]);
      expect(signals).toEqual([]);
    });
  });

  // --- New exports detection ---

  describe('new exports signal', () => {
    it('detects new exports in a fresh file (no oldContent)', async () => {
      const content = `
export function hello() {}
export const FOO = 'bar';
export class MyClass {}
`;
      const signals = await analyzeAstSignals([
        { path: 'src/mod.ts', content },
      ]);
      const sig = findSignal(signals, 'new_exports');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(3);
      expect(sig!.tierContribution).toBe('T3'); // 3+ exports = T3
    });

    it('detects 1-2 new exports as T2', async () => {
      const content = `
export function hello() {}
export const FOO = 'bar';
`;
      const signals = await analyzeAstSignals([
        { path: 'src/mod.ts', content },
      ]);
      const sig = findSignal(signals, 'new_exports');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(2);
      expect(sig!.tierContribution).toBe('T2');
      expect(sig!.weight).toBe(2);
    });

    it('detects only new exports when comparing old vs new', async () => {
      const oldContent = `
export function hello() {}
export const FOO = 'bar';
`;
      const content = `
export function hello() {}
export const FOO = 'bar';
export function newFunc() {}
export type NewType = string;
`;
      const signals = await analyzeAstSignals([
        { path: 'src/mod.ts', content, oldContent },
      ]);
      const sig = findSignal(signals, 'new_exports');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(2); // newFunc + NewType
    });

    it('does not emit signal when no new exports', async () => {
      const oldContent = `export function hello() {}`;
      const content = `export function hello() { return 1; }`;
      const signals = await analyzeAstSignals([
        { path: 'src/mod.ts', content, oldContent },
      ]);
      expect(findSignal(signals, 'new_exports')).toBeUndefined();
    });

    it('detects export default', async () => {
      const content = `export default function main() {}`;
      const signals = await analyzeAstSignals([
        { path: 'src/index.ts', content },
      ]);
      const sig = findSignal(signals, 'new_exports');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(1);
    });

    it('detects exported interfaces, types, and enums', async () => {
      const content = `
export interface Config {}
export type ID = string;
export enum Status { Active, Inactive }
`;
      const signals = await analyzeAstSignals([
        { path: 'src/types.ts', content },
      ]);
      const sig = findSignal(signals, 'new_exports');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(3);
    });
  });

  // --- New classes/interfaces detection ---

  describe('new classes signal', () => {
    it('detects new classes in a fresh file', async () => {
      const content = `
class Foo {}
class Bar extends Foo {}
`;
      const signals = await analyzeAstSignals([
        { path: 'src/models.ts', content },
      ]);
      const sig = findSignal(signals, 'new_classes');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(2);
      expect(sig!.tierContribution).toBe('T2');
    });

    it('detects new interfaces as classes', async () => {
      const content = `
interface Serializable {}
interface Disposable {}
class MyService implements Serializable {}
`;
      const signals = await analyzeAstSignals([
        { path: 'src/service.ts', content },
      ]);
      const sig = findSignal(signals, 'new_classes');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(3); // 2 interfaces + 1 class
    });

    it('counts only truly new classes when comparing old/new', async () => {
      const oldContent = `
class Existing {}
interface OldInterface {}
`;
      const content = `
class Existing {}
interface OldInterface {}
class NewClass {}
interface NewInterface {}
`;
      const signals = await analyzeAstSignals([
        { path: 'src/models.ts', content, oldContent },
      ]);
      const sig = findSignal(signals, 'new_classes');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(2);
    });

    it('does not emit signal when no new classes', async () => {
      const content = `const x = 1;\nfunction foo() {}`;
      const signals = await analyzeAstSignals([
        { path: 'src/util.ts', content },
      ]);
      expect(findSignal(signals, 'new_classes')).toBeUndefined();
    });
  });

  // --- Removed exports (breaking changes) ---

  describe('removed exports signal', () => {
    it('detects removed exports', async () => {
      const oldContent = `
export function hello() {}
export const FOO = 'bar';
export class Widget {}
`;
      const content = `
export function hello() {}
`;
      const signals = await analyzeAstSignals([
        { path: 'src/api.ts', content, oldContent },
      ]);
      const sig = findSignal(signals, 'removed_exports');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(2); // FOO + Widget removed
      expect(sig!.tierContribution).toBe('T3');
      expect(sig!.weight).toBe(3);
    });

    it('does not emit signal when nothing removed', async () => {
      const oldContent = `export function hello() {}`;
      const content = `export function hello() {}\nexport function world() {}`;
      const signals = await analyzeAstSignals([
        { path: 'src/api.ts', content, oldContent },
      ]);
      expect(findSignal(signals, 'removed_exports')).toBeUndefined();
    });

    it('does not emit signal on fresh file (no oldContent)', async () => {
      const content = `export function hello() {}`;
      const signals = await analyzeAstSignals([
        { path: 'src/new.ts', content },
      ]);
      expect(findSignal(signals, 'removed_exports')).toBeUndefined();
    });
  });

  // --- Schema changes ---

  describe('schema change signal', () => {
    it('detects Prisma model definitions', async () => {
      const content = `
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]
}

model Post {
  id       Int    @id @default(autoincrement())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`;
      const signals = await analyzeAstSignals([
        { path: 'prisma/schema.prisma', content },
      ]);
      const sig = findSignal(signals, 'schema_change');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(true);
      expect(sig!.tierContribution).toBe('T3');
      expect(sig!.weight).toBe(4);
    });

    it('detects Prisma @@ attributes', async () => {
      const content = `
model User {
  firstName String
  lastName  String
  @@unique([firstName, lastName])
}
`;
      const signals = await analyzeAstSignals([
        { path: 'schema.prisma', content },
      ]);
      expect(findSignal(signals, 'schema_change')).toBeDefined();
    });

    it('detects SQL CREATE TABLE', async () => {
      const content = `
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);
`;
      const signals = await analyzeAstSignals([
        { path: 'migrations/001.sql', content },
      ]);
      const sig = findSignal(signals, 'schema_change');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(true);
      expect(sig!.tierContribution).toBe('T3');
    });

    it('detects SQL ALTER TABLE', async () => {
      const content = `ALTER TABLE users ADD COLUMN email VARCHAR(255);`;
      const signals = await analyzeAstSignals([
        { path: 'migrations/002.sql', content },
      ]);
      expect(findSignal(signals, 'schema_change')).toBeDefined();
    });

    it('detects Zod schema definitions in TS files', async () => {
      const content = `
import { z } from 'zod';

const UserSchema = z.object({
  name: z.string(),
  age: z.number(),
});
`;
      const signals = await analyzeAstSignals([
        { path: 'src/schemas/user.ts', content },
      ]);
      expect(findSignal(signals, 'schema_change')).toBeDefined();
    });

    it('does not detect schema in plain JS with no schema patterns', async () => {
      const content = `
const x = 1;
function foo() { return x + 1; }
export { foo };
`;
      const signals = await analyzeAstSignals([
        { path: 'src/util.ts', content },
      ]);
      expect(findSignal(signals, 'schema_change')).toBeUndefined();
    });
  });

  // --- Dependency changes ---

  describe('dependency changes signal', () => {
    it('detects new dependencies in a fresh package.json', async () => {
      const content = JSON.stringify({
        name: 'my-app',
        dependencies: {
          'react': '^18.0.0',
          'react-dom': '^18.0.0',
        },
        devDependencies: {
          'vitest': '^2.0.0',
        },
      });
      const signals = await analyzeAstSignals([
        { path: 'package.json', content },
      ]);
      const sig = findSignal(signals, 'dependency_changes');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(3); // react + react-dom + vitest
      expect(sig!.tierContribution).toBe('T3'); // 3+ = T3
    });

    it('detects added and removed deps between versions', async () => {
      const oldContent = JSON.stringify({
        dependencies: {
          'lodash': '^4.0.0',
          'express': '^4.18.0',
        },
      });
      const content = JSON.stringify({
        dependencies: {
          'express': '^4.18.0',
          'fastify': '^4.0.0',
        },
      });
      const signals = await analyzeAstSignals([
        { path: 'package.json', content, oldContent },
      ]);
      const sig = findSignal(signals, 'dependency_changes');
      expect(sig).toBeDefined();
      expect(sig!.value).toBe(2); // lodash removed + fastify added
      expect(sig!.tierContribution).toBe('T2'); // <3 = T2
    });

    it('does not emit signal when no dependency changes', async () => {
      const content = JSON.stringify({
        dependencies: { 'react': '^18.0.0' },
      });
      const signals = await analyzeAstSignals([
        { path: 'package.json', content, oldContent: content },
      ]);
      expect(findSignal(signals, 'dependency_changes')).toBeUndefined();
    });

    it('handles package.json with no dependency sections', async () => {
      const content = JSON.stringify({ name: 'my-lib', version: '1.0.0' });
      const signals = await analyzeAstSignals([
        { path: 'package.json', content },
      ]);
      expect(findSignal(signals, 'dependency_changes')).toBeUndefined();
    });
  });

  // --- Multi-file aggregation ---

  describe('multi-file aggregation', () => {
    it('aggregates signals from multiple files', async () => {
      const files: AnalyzableFile[] = [
        {
          path: 'src/a.ts',
          content: 'export function foo() {}\nexport function bar() {}',
        },
        {
          path: 'src/b.ts',
          content: 'export class Baz {}',
        },
      ];
      const signals = await analyzeAstSignals(files);
      const exportSig = findSignal(signals, 'new_exports');
      expect(exportSig).toBeDefined();
      expect(exportSig!.value).toBe(3); // foo + bar + Baz
      expect(exportSig!.tierContribution).toBe('T3'); // 3+ = T3
    });

    it('mixes supported and unsupported files gracefully', async () => {
      const files: AnalyzableFile[] = [
        { path: 'src/mod.ts', content: 'export function hello() {}' },
        { path: 'docs/notes.md', content: '# Notes\nSome text' },
        { path: 'data/config.yaml', content: 'key: value' },
      ];
      const signals = await analyzeAstSignals(files);
      // Only the .ts file produces signals
      const exportSig = findSignal(signals, 'new_exports');
      expect(exportSig).toBeDefined();
      expect(exportSig!.value).toBe(1);
    });

    it('combines schema signals from multiple schema files', async () => {
      const files: AnalyzableFile[] = [
        { path: 'prisma/schema.prisma', content: 'model User { id Int @id }' },
        { path: 'migrations/001.sql', content: 'CREATE TABLE posts (id INT);' },
      ];
      const signals = await analyzeAstSignals(files);
      const schemaSig = findSignal(signals, 'schema_change');
      expect(schemaSig).toBeDefined();
      expect(schemaSig!.value).toBe(true);
    });
  });

  // --- File type detection ---

  describe('file type detection', () => {
    it('recognizes .js files', async () => {
      const signals = await analyzeAstSignals([
        { path: 'src/util.js', content: 'export function foo() {}' },
      ]);
      expect(findSignal(signals, 'new_exports')).toBeDefined();
    });

    it('recognizes .jsx files', async () => {
      const signals = await analyzeAstSignals([
        { path: 'src/App.jsx', content: 'export function App() {}' },
      ]);
      expect(findSignal(signals, 'new_exports')).toBeDefined();
    });

    it('recognizes .tsx files', async () => {
      const signals = await analyzeAstSignals([
        { path: 'src/App.tsx', content: 'export function App() {}' },
      ]);
      expect(findSignal(signals, 'new_exports')).toBeDefined();
    });

    it('recognizes .ts files', async () => {
      const signals = await analyzeAstSignals([
        { path: 'src/index.ts', content: 'export const x = 1;' },
      ]);
      expect(findSignal(signals, 'new_exports')).toBeDefined();
    });
  });

  // --- Signal shape validation ---

  describe('signal shape', () => {
    it('all signals have required fields', async () => {
      const files: AnalyzableFile[] = [
        {
          path: 'src/big-change.ts',
          content: `
export function a() {}
export function b() {}
export function c() {}
export class Foo {}
import { z } from 'zod';
const schema = z.object({ x: z.string() });
`,
          oldContent: `
export function removed() {}
`,
        },
      ];
      const signals = await analyzeAstSignals(files);
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) {
        expect(signal).toHaveProperty('name');
        expect(signal).toHaveProperty('value');
        expect(signal).toHaveProperty('weight');
        expect(signal).toHaveProperty('tierContribution');
        expect(typeof signal.name).toBe('string');
        expect(typeof signal.weight).toBe('number');
        expect(['T1', 'T2', 'T3', 'T4']).toContain(signal.tierContribution);
      }
    });
  });
});
