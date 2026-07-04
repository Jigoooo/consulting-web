import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  sub: string;
  typ: 'access' | 'refresh';
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signInput(header: object, payload: object): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const input = signInput({ alg: 'HS256', typ: 'JWT' }, claims);
  const sig = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

export function verifyJwt(token: string, secret: string, expectedType: JwtClaims['typ']): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sig] = parts as [string, string, string];
  const input = `${headerB64}.${payloadB64}`;
  const expected = createHmac('sha256', secret).update(input).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as JwtClaims;
    if (claims.typ !== expectedType) return null;
    if (!claims.sub || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
