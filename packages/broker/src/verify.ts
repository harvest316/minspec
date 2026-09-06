/**
 * OIDC token verification for the review-broker (SPEC-034 task 1.1, AC-1).
 *
 * Verifies a GitHub Actions OIDC JWT against GitHub's JWKS: RS256 signature, issuer,
 * audience, and expiry. Anything that fails is a 401 and yields no claims — there is
 * no partial success, because a half-verified token is exactly the input the
 * confused-deputy rule downstream assumes it will never receive.
 *
 * WHY `jose` RATHER THAN HAND-ROLLED (design dependency budget): JWT verification in
 * WebCrypto is a classic footgun — algorithm confusion (accepting `none`, or an HMAC
 * token verified against a public key as its secret), `kid` handling, and JWKS caching
 * are each their own CVE class. `jose` is the vetted implementation and runs on the
 * Workers runtime.
 *
 * The JWKS resolver is INJECTED. That keeps this module testable with locally-minted
 * keys and no network at all — the tests sign real JWTs with a real keypair and verify
 * real signatures, so they exercise the actual crypto path rather than a mock of it.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { VerifiedClaims } from './decide';

/** GitHub's OIDC issuer. */
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/** JWKS endpoint (used by the default resolver). */
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

export type VerifyResult =
  | { ok: true; claims: VerifiedClaims }
  | { ok: false; reason: string };

/**
 * Verify an OIDC JWT and extract ONLY the claims the broker authorises from.
 *
 * `audience` must be supplied by the caller and is not defaulted: an unconstrained
 * audience would accept a token GitHub minted for a different service, which is the
 * whole reason `aud` exists. A missing audience is a configuration error, not a
 * permissive default.
 */
export async function verifyOidcToken(
  token: string,
  audience: string,
  getKey: JWTVerifyGetKey,
): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'missing token' };
  }
  if (typeof audience !== 'string' || audience.length === 0) {
    // Fail closed on misconfiguration rather than verifying against "anything".
    return { ok: false, reason: 'broker audience not configured' };
  }

  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: GITHUB_OIDC_ISSUER,
      audience,
      // Pin the algorithm. Without this an attacker-chosen `alg` is accepted as long
      // as it verifies — the alg-confusion class this module exists to avoid.
      algorithms: ['RS256'],
    });

    const repository = payload.repository;
    const repository_owner = payload.repository_owner;
    if (typeof repository !== 'string' || repository.length === 0) {
      // A token without a repository claim authorises nothing. Treat it as invalid
      // rather than passing empty claims to the decision layer.
      return { ok: false, reason: 'token carries no repository claim' };
    }

    return {
      ok: true,
      claims: {
        repository,
        repository_owner: typeof repository_owner === 'string' ? repository_owner : '',
      },
    };
  } catch {
    // jose distinguishes expiry, audience, issuer and signature failures, and the error
    // NAME carries that distinction (`JWSSignatureVerificationFailed`, `JWTExpired`, …).
    // Returning it would hand a caller a probing oracle: mint tokens, read which check
    // tripped, and tune the next attempt. Every failure means the same thing to us — no
    // token — so a single constant is returned and the specific cause is deliberately
    // discarded rather than logged back to the requester.
    //
    // (An earlier revision returned `err.name` here, contradicting this very comment.
    //  The disclosure test below is what caught it.)
    return { ok: false, reason: 'invalid token' };
  }
}

/** The default resolver: GitHub's live JWKS. Replaced in tests. */
export async function defaultJwks(): Promise<JWTVerifyGetKey> {
  return createRemoteJWKSet(new URL(GITHUB_OIDC_JWKS_URL));
}
