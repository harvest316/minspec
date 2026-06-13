#!/usr/bin/env python3
"""Python-twin golden-fixture test — SPEC-022 / INV-2.

Asserts `canonical.py` reproduces the SAME pinned golden outputs the Node unit
test (`canonical.test.ts`) asserts against. A divergence here fails BEFORE the
corpus parity test and points at the exact rule. Pure stdlib unittest — run with:

    python3 scripts/hooks/test_canonical.py

(also collected by CI alongside the Node suite).
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from canonical import canonicalize_spec, spec_hash  # noqa: E402

# Repo-root-relative path to the shared golden fixtures (same set the Node test uses).
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, '..', '..'))
_FIXTURE_DIR = os.path.join(
    _REPO_ROOT, 'packages', 'minspec', 'tests', 'fixtures', 'canonical'
)


class CanonicalGoldenFixtures(unittest.TestCase):
    def _names(self):
        return sorted(
            f[:-len('.input')]
            for f in os.listdir(_FIXTURE_DIR)
            if f.endswith('.input')
        )

    def test_has_fixtures(self):
        self.assertGreater(len(self._names()), 0, 'no golden fixtures found')

    def test_goldens(self):
        for name in self._names():
            with self.subTest(fixture=name):
                with open(os.path.join(_FIXTURE_DIR, name + '.input'), encoding='utf-8') as fh:
                    raw = fh.read()
                with open(os.path.join(_FIXTURE_DIR, name + '.expected'), encoding='utf-8') as fh:
                    expected = fh.read()
                self.assertEqual(canonicalize_spec(raw), expected)


class CanonicalLifecycleNonVoid(unittest.TestCase):
    BASE = (
        '---\n'
        'id: SPEC-007\n'
        'tier: T3\n'
        'status: specifying\n'
        'phases:\n'
        '  specify: done\n'
        '  plan: pending\n'
        '---\n'
        '# Thing\n\nThe body.\n'
    )

    def test_status_edit_non_void(self):
        edited = self.BASE.replace('status: specifying', 'status: implementing')
        self.assertEqual(spec_hash(edited), spec_hash(self.BASE))

    def test_phases_edit_non_void(self):
        edited = self.BASE.replace('  plan: pending', '  plan: done')
        self.assertEqual(spec_hash(edited), spec_hash(self.BASE))

    def test_body_edit_voids(self):
        edited = self.BASE.replace('The body.', 'Edited.')
        self.assertNotEqual(spec_hash(edited), spec_hash(self.BASE))

    def test_crlf_equals_lf(self):
        crlf = self.BASE.replace('\n', '\r\n')
        self.assertEqual(spec_hash(crlf), spec_hash(self.BASE))


if __name__ == '__main__':
    unittest.main()
