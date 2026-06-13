#!/usr/bin/env python3
"""Canonical spec hashing — SPEC-022 / DR-034 (FR-3). Python twin.

Byte-for-byte twin of `packages/shared/src/canonical.ts`. The PreToolUse gate
(`spec-gate.py`) is Python and cannot import the Node package, so it imports this
module instead. INV-2 (the corpus-parity test) asserts this twin and the Node
module produce byte-identical output over every spec in `specs/`.

Keep the two in lockstep: any change to the Node module must be mirrored here, or
INV-2 fails. The algorithm (see the Node module for the full prose):

  1. Normalize EOL to \n up front.
  2. Split the frontmatter block from the body.
  3. Remove exactly the lifecycle keys `status` and `phases` (+ indented children).
  4. Rejoin frontmatter-minus-lifecycle + body.
  5. Strip per-line trailing whitespace; collapse the trailing newline run to one.
  6. sha256 the UTF-8 bytes; return the hex digest.

Pure stdlib (`re`, `hashlib`). Also runnable as a CLI: `canonical.py --hash <file>`
prints the hex digest of the file's canonical form (used by the parity test).
"""
import hashlib
import re
import sys

# Same anchor as the Node FRONTMATTER_RE and spec.ts: leading `---\n`, lazy block,
# then `\n---` with an optional trailing newline. Operates on \n-normalized input.
_FRONTMATTER_RE = re.compile(r'^---\n([\s\S]*?)\n---\n?')

_STATUS_LINE_RE = re.compile(r'^status[ \t]*:')
_PHASES_LINE_RE = re.compile(r'^phases[ \t]*:')
_INDENTED_LINE_RE = re.compile(r'^[ \t]+')


def _strip_lifecycle(fm: str) -> str:
    """Drop `status` line + `phases` block (its indented children), KEEP all else."""
    out = []
    in_phases_block = False
    for line in fm.split('\n'):
        if in_phases_block:
            if _INDENTED_LINE_RE.match(line):
                continue  # drop child line
            in_phases_block = False
            # fall through: re-evaluate this line as a top-level key
        if _PHASES_LINE_RE.match(line):
            in_phases_block = True
            continue  # drop the `phases:` line itself
        if _STATUS_LINE_RE.match(line):
            continue  # drop the `status:` line
        out.append(line)
    return '\n'.join(out)


def canonicalize_spec(raw: str) -> str:
    """Compute the canonical string form of a raw spec (mirrors canonicalizeSpec)."""
    # 1. Normalize EOL up front.
    normalized = re.sub(r'\r\n?', '\n', raw)

    # 2. Split frontmatter from body.
    m = _FRONTMATTER_RE.match(normalized)
    if not m:
        joined = normalized
    else:
        fm = m.group(1)
        body = normalized[m.end():]
        # 3. Remove lifecycle keys. 4. Rejoin.
        fm_clean = _strip_lifecycle(fm)
        joined = '---\n' + fm_clean + '\n---\n' + body

    # 5. Strip per-line trailing whitespace (str.rstrip() == JS trimEnd over a
    #    newline-free line), then collapse the trailing newline run to exactly one.
    lines = [ln.rstrip() for ln in joined.split('\n')]
    return re.sub(r'\n*$', '', '\n'.join(lines)) + '\n'


def spec_hash(raw: str) -> str:
    """sha256 hex digest of the canonical form (FR-3)."""
    return hashlib.sha256(canonicalize_spec(raw).encode('utf-8')).hexdigest()


def _main(argv):
    if len(argv) == 3 and argv[1] == '--hash':
        with open(argv[2], 'r', encoding='utf-8') as fh:
            sys.stdout.write(spec_hash(fh.read()))
        return 0
    sys.stderr.write('usage: canonical.py --hash <file>\n')
    return 2


if __name__ == '__main__':
    sys.exit(_main(sys.argv))
