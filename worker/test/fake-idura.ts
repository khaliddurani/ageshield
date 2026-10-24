import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { AGE_CLAIM } from '../src/lib/idura';
import { IDURA_CLIENT_ID, IDURA_DOMAIN } from './helpers';

// Fake Idura tenant: discovery document, JWKS and token endpoint, with real RS256 keys (jose test keys).

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export const ISSUER = `https://${IDURA_DOMAIN}`;

export interface TokenRequest {
  headers: Headers;
  body: URLSearchParams;
}

export class FakeIdura {
  /** Claims of the next id_token (merged over the defaults). */
  claims: JWTPayload = {};
  /** Sign with another key than the JWKS publishes. */
  signWithOtherKey = false;
  /** Token endpoint answer instead of a token. */
  tokenError: { status: number; body: unknown } | null = null;
  tokenRequests: TokenRequest[] = [];
  discoveryOverride: Record<string, unknown> | null = null;
  now = Date.now();

  private constructor(
    private readonly key: KeyPair,
    private readonly otherKey: KeyPair,
  ) {}

  /** RSA key generation is slow; one key pair per test file is enough. */
  private static keys: Promise<[KeyPair, KeyPair]> | null = null;

  static async create(): Promise<FakeIdura> {
    FakeIdura.keys ??= Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
    const [key, otherKey] = await FakeIdura.keys;
    return new FakeIdura(key, otherKey);
  }

  /** Default claims for a verified Danish adult, shaped like the test tenant's (2026-10-24), minus identity claims. */
  defaultClaims(nonce: string): JWTPayload {
    return {
      nonce,
      authenticationinstant: new Date(this.now).toISOString(),
      identityscheme: 'dkmitid',
      ial: 'low',
      sub: '{pseudonym-must-never-be-stored}',
      nameidentifier: 'nameid-must-never-be-stored',
      sessionindex: 'session-must-never-be-stored',
      [AGE_CLAIM]: { country: 'DK', auditId: 'alu_test_123', is_over_18: true },
    };
  }

  /** Nonce for the next token: the test reads it from the stored oidc_states row. */
  nonce = '';

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json(
        this.discoveryOverride ?? {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          jwks_uri: `${ISSUER}/.well-known/jwks`,
        },
      );
    }
    if (url === `${ISSUER}/.well-known/jwks`) {
      return Response.json({
        keys: [{ ...(await exportJWK(this.key.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }],
      });
    }
    if (url === `${ISSUER}/oauth2/token`) {
      this.tokenRequests.push({
        headers: new Headers(init?.headers),
        body: new URLSearchParams(String(init?.body)),
      });
      if (this.tokenError) return Response.json(this.tokenError.body, { status: this.tokenError.status });
      return Response.json({ id_token: await this.idToken(), access_token: 'unused', token_type: 'Bearer' });
    }
    throw new Error(`FakeIdura: unexpected request ${url}`);
  };

  async idToken(): Promise<string> {
    const nowS = Math.floor(this.now / 1000);
    const claims = { ...this.defaultClaims(this.nonce), ...this.claims };
    // Like the tenant: exp years ahead (the Worker must not rely on it).
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer((claims['iss'] as string | undefined) ?? ISSUER)
      .setAudience((claims['aud'] as string | undefined) ?? IDURA_CLIENT_ID)
      .setIssuedAt(typeof claims.iat === 'number' ? claims.iat : nowS)
      .setNotBefore(typeof claims.nbf === 'number' ? claims.nbf : nowS)
      .setExpirationTime(nowS + 5 * 365 * 86_400);
    return jwt.sign((this.signWithOtherKey ? this.otherKey : this.key).privateKey);
  }
}
