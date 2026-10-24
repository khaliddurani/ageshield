import { jwtVerify, type JWTPayload } from 'jose';
import { isValidShopDomain } from './shop';

/** Clock skew allowed on `exp` / `nbf`, in seconds. */
const CLOCK_TOLERANCE_S = 5;

export class InvalidSessionTokenError extends Error {
  override name = 'InvalidSessionTokenError';
}

export interface VerifiedSessionToken {
  shop: string;
  payload: JWTPayload;
}

function hostnameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * Verifies an App Bridge session token (ID token): HS256 with the client secret, `aud` = client ID,
 * `exp`/`nbf` with 5s skew, and `iss`/`dest` hostnames equal and a valid shop domain.
 */
export async function verifySessionToken(
  token: string,
  apiKey: string,
  apiSecret: string,
): Promise<VerifiedSessionToken> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, new TextEncoder().encode(apiSecret), {
      algorithms: ['HS256'],
      audience: apiKey,
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ['exp', 'nbf', 'iss', 'dest'],
    }));
  } catch (err) {
    throw new InvalidSessionTokenError(err instanceof Error ? err.message : 'Invalid session token');
  }

  const dest = hostnameOf(payload['dest']);
  if (!dest || !isValidShopDomain(dest)) throw new InvalidSessionTokenError('Invalid dest claim');
  if (hostnameOf(payload.iss) !== dest) throw new InvalidSessionTokenError('iss and dest do not match');

  return { shop: dest, payload };
}
