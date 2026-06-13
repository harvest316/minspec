# Canonical golden fixtures (SPEC-022 / INV-2, INV-3)

Each case is a pair, shared by the Node unit test (`canonical.test.ts`) and the
Python unit test (`scripts/hooks/test_canonical.py`):

- `<name>.input` — the raw spec bytes fed to `canonicalizeSpec`.
- `<name>.expected` — the EXACT canonical output (hand-pinned, not derived).

Both twins assert `canonicalizeSpec(input) === expected` for every case, so a
divergence fails *before* the corpus parity test and points at the exact rule.

Files use `.input` / `.expected` (not `.md`) so the corpus-parity walker over
`specs/**/*.md` never picks them up, and so editors don't reflow them.
