/**
 * SPEC-034 tasks 1.1 + 1.3 — OIDC verification and scoped minting.
 *
 * These tests sign REAL JWTs with a REAL keypair and verify REAL signatures. Nothing
 * about the crypto path is mocked: only the JWKS lookup is injected, so there is no
 * network but the verification itself is genuine. A mocked verifier would prove only
 * that the mock was called.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import {
  verifyOidcToken,
  GITHUB_OIDC_ISSUER,
} from '../../broker/src/verify';
import {
  findWidening,
  mintScopedToken,
  clampExpiry,
  REVIEW_PERMISSIONS,
  MAX_TTL_SECONDS,
  type InstallationTokenFactory,
} from '../../broker/src/mint';

const AUD = 'https://minspec-review-broker.workers.dev';
const REPO = 'AIClarityAU/voip-sms-inbox';

/** A real RS256 keypair + a local JWKS that trusts it. */
async function keyring() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

async function sign(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; expIn?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? GITHUB_OIDC_ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.expIn ?? '5m')
    .sign(privateKey);
}

describe('AC-1 — OIDC verification', () => {
  it('accepts a well-formed token and extracts the repository claim', async () => {
    const { privateKey, jwks } = await keyring();
    const token = await sign(privateKey, { repository: REPO, repository_owner: 'AIClarityAU' });
    const r = await verifyOidcToken(token, AUD, jwks);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.claims.repository).toBe(REPO);
  });

  it('REJECTS a token signed by a different key', async () => {
    // The core property. An attacker minting their own token must not be believed.
    const good = await keyring();
    const evil = await keyring();
    const token = await sign(evil.privateKey, { repository: REPO });
    const r = await verifyOidcToken(token, AUD, good.jwks);
    expect(r.ok).toBe(false);
  });

  it('REJECTS an expired token', async () => {
    const { privateKey, jwks } = await keyring();
    const token = await sign(privateKey, { repository: REPO }, { expIn: '-1m' });
    expect((await verifyOidcToken(token, AUD, jwks)).ok).toBe(false);
  });

  it('REJECTS a token minted for a different audience', async () => {
    // Why `aud` exists: a token GitHub legitimately issued for another service must
    // not authorise anything here.
    const { privateKey, jwks } = await keyring();
    const token = await sign(privateKey, { repository: REPO }, { aud: 'https://someone-else' });
    expect((await verifyOidcToken(token, AUD, jwks)).ok).toBe(false);
  });

  it('REJECTS a token from a different issuer', async () => {
    const { privateKey, jwks } = await keyring();
    const token = await sign(privateKey, { repository: REPO }, { iss: 'https://evil.example' });
    expect((await verifyOidcToken(token, AUD, jwks)).ok).toBe(false);
  });

  it('REJECTS a valid signature with no repository claim', async () => {
    // Genuinely signed, genuinely useless: it authorises nothing, so it must not
    // reach the decision layer as empty claims.
    const { privateKey, jwks } = await keyring();
    const token = await sign(privateKey, { repository_owner: 'AIClarityAU' });
    expect((await verifyOidcToken(token, AUD, jwks)).ok).toBe(false);
  });

  it('fails closed when the broker audience is unconfigured', async () => {
    // Misconfiguration must not become "verify against anything".
    const { privateKey, jwks } = await keyring();
    const token = await sign(privateKey, { repository: REPO });
    expect((await verifyOidcToken(token, '', jwks)).ok).toBe(false);
  });

  it('does not disclose WHICH check failed', async () => {
    // A precise reason is a probing oracle; all failures mean the same thing to us.
    const good = await keyring();
    const evil = await keyring();
    const r = await verifyOidcToken(await sign(evil.privateKey, { repository: REPO }), AUD, good.jwks);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toMatch(/signature|audience|issuer|expired/i);
  });
});

describe('AC-3 — scoped minting', () => {
  const okFactory: InstallationTokenFactory = async ({ permissions }) => ({
    token: 'ghs_test',
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    permissions,
  });

  it('scopes the token to exactly one repository — the CLAIM', async () => {
    const r = await mintScopedToken({ repository: REPO, repository_owner: 'AIClarityAU' }, okFactory);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.minted.repositories).toEqual([REPO]);
  });

  it('carries only the review permission set', async () => {
    const r = await mintScopedToken({ repository: REPO, repository_owner: '' }, okFactory);
    expect(r.ok === true && r.minted.permissions).toEqual({ ...REVIEW_PERMISSIONS });
    expect(Object.keys(REVIEW_PERMISSIONS)).not.toContain('contents');
    expect(Object.keys(REVIEW_PERMISSIONS)).not.toContain('administration');
  });

  it('reports expires_at on the minted response, inside the ceiling', async () => {
    // clampExpiry is unit-tested separately; this asserts the RESPONSE actually carries
    // the clamped value, which is the field a caller trusts.
    const r = await mintScopedToken({ repository: REPO, repository_owner: '' }, okFactory);
    expect(r.ok).toBe(true);
    const expiresAt = r.ok === true ? r.minted.expires_at : '';
    expect(Number.isNaN(Date.parse(expiresAt))).toBe(false);
    const ttlMs = Date.parse(expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(MAX_TTL_SECONDS * 1000);
  });

  describe('permission widening — the check mint.ts promises', () => {
    const granting = (permissions: Record<string, string>): InstallationTokenFactory =>
      async () => ({
        token: 'ghs_test',
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
        permissions,
      });

    const mint = (f: InstallationTokenFactory) =>
      mintScopedToken({ repository: REPO, repository_owner: '' }, f);

    it('REFUSES a scope that was never requested', async () => {
      const r = await mint(granting({ ...REVIEW_PERMISSIONS, contents: 'write' }));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('ghs_');
    });

    it('REFUSES a level wider than requested', async () => {
      const r = await mint(granting({ ...REVIEW_PERMISSIONS, issues: 'admin' }));
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('ghs_');
    });

    it('REFUSES a level it cannot rank, rather than waving it through', async () => {
      const r = await mint(granting({ ...REVIEW_PERMISSIONS, issues: 'sudo' }));
      expect(r.ok).toBe(false);
    });

    it('REFUSES when the provider reports no permissions at all', async () => {
      // A token whose scope cannot be read cannot be vouched for (invariant 2).
      const silent = (async () => ({
        token: 'ghs_test',
        expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
      })) as unknown as InstallationTokenFactory;
      const r = await mint(silent);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('ghs_');
    });

    it('ACCEPTS a NARROWER grant, and reports what was actually granted', async () => {
      // Control for the four refusals above: the guard must not simply reject everything.
      const narrow = { issues: 'write', pull_requests: 'write' };
      const r = await mint(granting(narrow));
      expect(r.ok).toBe(true);
      expect(r.ok === true && r.minted.permissions).toEqual(narrow);
    });

    it('findWidening returns null for the exact review profile', () => {
      expect(findWidening({ ...REVIEW_PERMISSIONS })).toBeNull();
    });
  });

  it('REFUSES a token whose TTL exceeds the ceiling', async () => {
    // GitHub's default is an hour. Minting it anyway would silently turn a 10-minute
    // credential into a 60-minute one — invisible until a leaked token still works.
    const longLived: InstallationTokenFactory = async ({ permissions }) => ({
      token: 'ghs_test',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      permissions,
    });
    expect((await mintScopedToken({ repository: REPO, repository_owner: '' }, longLived)).ok).toBe(false);
  });

  it('never returns a token when the factory throws (AC-9)', async () => {
    const boom: InstallationTokenFactory = async () => {
      throw new Error('installation not found');
    };
    const r = await mintScopedToken({ repository: REPO, repository_owner: '' }, boom);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('ghs_');
  });

  it('does not echo provider error detail', async () => {
    const boom: InstallationTokenFactory = async () => {
      throw new Error('App 4212099 installation 144283146 denied');
    };
    const r = await mintScopedToken({ repository: REPO, repository_owner: '' }, boom);
    expect(r.ok === false && r.reason).not.toMatch(/4212099|144283146/);
  });

  it('refuses to mint without a verified repository', async () => {
    // The confused-deputy rule enforced by the type: there is no way to ask for a repo
    // that was never verified.
    expect((await mintScopedToken({ repository: '', repository_owner: '' }, okFactory)).ok).toBe(false);
  });

  describe('clampExpiry', () => {
    const now = Date.parse('2026-09-05T00:00:00.000Z');
    it('accepts a TTL inside the ceiling', () => {
      expect(clampExpiry(new Date(now + 9 * 60_000).toISOString(), now)).toBeTruthy();
    });
    it('rejects exactly over the ceiling', () => {
      expect(clampExpiry(new Date(now + (MAX_TTL_SECONDS + 1) * 1000).toISOString(), now)).toBeNull();
    });
    it('rejects an already-expired or unparseable expiry', () => {
      expect(clampExpiry(new Date(now - 1000).toISOString(), now)).toBeNull();
      expect(clampExpiry('not a date', now)).toBeNull();
      expect(clampExpiry(undefined, now)).toBeNull();
    });
  });
});
