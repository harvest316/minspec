/**
 * @aiclarity/shared — public barrel.
 *
 * Consumers import from the package name (`@aiclarity/shared`), never from
 * deep source paths (`../../shared/src/...`). Deep source imports drag this
 * package's source into the consumer's tsc program and force its rootDir up
 * to `packages/`, triggering TS6 "common source directory is '..'".
 */
export * from './contracts/conformance';
export * from './canonical'; // includes getSpecBodyOnly (SPEC-017 FR-4)
export * from './rework'; // SPEC-017 M1 — reworkPct
export * from './review-signals';
export * from './next-task';
