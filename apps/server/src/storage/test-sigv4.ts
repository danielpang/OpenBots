import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// AWS Signature Version 4, as a store checks it, written from the
// specification with node:crypto alone, for the S3 stand-in (test-s3.ts):
// "Authenticating Requests (AWS Signature Version 4)" in the Amazon S3 API
// reference, and "Create a signed AWS API request" in the IAM guide. It
// shares no code with the client's signer (aws4fetch), so a mistake in one
// is not repeated in the other. Its own known-answer tests are AWS's
// published examples (test-sigv4.test.ts).
//
// The steps:
// 1. Canonical request: method, canonical URI, canonical query string,
//    canonical headers, signed headers and the payload's hash, one a line.
// 2. String to sign: `AWS4-HMAC-SHA256`, the request's time, the scope
//    (`<date>/<region>/<service>/aws4_request`) and the canonical request's
//    hex sha256.
// 3. Signing key: HMAC-SHA256 of the date with `AWS4<secret>`, then of the
//    region, the service and `aws4_request`, each keyed by the one before.
// 4. Signature: hex HMAC-SHA256 of the string to sign with that key.

export type Headers = Record<string, string | string[] | undefined>;

export interface SigningInput {
  method: string;
  /** The path and query as sent, such as `/bucket/key?x=1`. */
  url: string;
  headers: Headers;
  /** Lower case header names, as in SignedHeaders. */
  signedHeaders: string[];
  secretAccessKey: string;
  region: string;
  service: string;
  /** `x-amz-date`: YYYYMMDD'T'HHMMSS'Z'. */
  amzDate: string;
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding: everything but A-Z a-z 0-9 - . _ ~ as %XX, upper case. */
export function uriEncode(value: string): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const ch = String.fromCharCode(byte);
      return /[A-Za-z0-9\-._~]/.test(ch)
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, '%20'));

/** S3's canonical URI: each segment of the path encoded once, slashes kept, never normalized. */
function canonicalUri(path: string): string {
  return path
    .split('/')
    .map((segment) => uriEncode(decode(segment)))
    .join('/');
}

/** Parameters encoded, sorted by name then value, a missing value as empty. */
function canonicalQuery(query: string): string {
  if (!query) return '';
  return query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const name = at < 0 ? pair : pair.slice(0, at);
      const value = at < 0 ? '' : pair.slice(at + 1);
      return [uriEncode(decode(name)), uriEncode(decode(value))] as const;
    })
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** A header's value: trimmed, inner runs of spaces as one, repeats joined by commas. */
function headerValue(value: string | string[]): string {
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => v.trim().replace(/\s+/g, ' ')).join(',');
}

export function canonicalRequest(input: SigningInput): string {
  const at = input.url.indexOf('?');
  const path = at < 0 ? input.url : input.url.slice(0, at);
  const query = at < 0 ? '' : input.url.slice(at + 1);
  const lower = Object.fromEntries(
    Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const headers = [...input.signedHeaders]
    .sort()
    .map((name) => `${name}:${headerValue(lower[name] ?? '')}\n`)
    .join('');
  return [
    input.method.toUpperCase(),
    canonicalUri(path || '/'),
    canonicalQuery(query),
    headers,
    [...input.signedHeaders].sort().join(';'),
    headerValue(lower['x-amz-content-sha256'] ?? sha256Hex('')),
  ].join('\n');
}

export function stringToSign(input: SigningInput): string {
  const scope = `${input.amzDate.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  return ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest(input))].join('\n');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

export function signature(input: SigningInput): string {
  const key = signingKey(
    input.secretAccessKey,
    input.amzDate.slice(0, 8),
    input.region,
    input.service,
  );
  return createHmac('sha256', key).update(stringToSign(input)).digest('hex');
}

const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^/\s]+)\/(\d{8})\/([^/\s]+)\/([^/\s]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/;

/**
 * Checks a request's Authorization header as S3 would, strictly: the payload
 * must be signed (its sha256, never UNSIGNED-PAYLOAD), and host,
 * x-amz-content-sha256 and x-amz-date must be among the signed headers.
 * Null when it holds; otherwise the S3 error code to answer with.
 */
export function verifySigV4(
  request: { method: string; url: string; headers: Headers },
  credentials: { accessKeyId: string; secretAccessKey: string; region: string; service?: string },
): string | null {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? AUTHORIZATION.exec(header) : null;
  if (!match) return 'AccessDenied';
  const [, keyId, date, region, service, signed, given] = match as unknown as string[];
  if (keyId !== credentials.accessKeyId) return 'InvalidAccessKeyId';
  if (region !== credentials.region || service !== (credentials.service ?? 's3')) {
    return 'AuthorizationHeaderMalformed';
  }
  const signedHeaders = signed!.split(';');
  for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
    if (!signedHeaders.includes(required)) return 'AccessDenied';
  }
  const amzDate = request.headers['x-amz-date'];
  if (typeof amzDate !== 'string' || !/^\d{8}T\d{6}Z$/.test(amzDate)) return 'AccessDenied';
  if (amzDate.slice(0, 8) !== date) return 'AuthorizationHeaderMalformed';
  const payload = request.headers['x-amz-content-sha256'];
  if (typeof payload !== 'string' || !/^[0-9a-f]{64}$/.test(payload)) {
    // UNSIGNED-PAYLOAD and the streaming forms included: the body must be signed.
    return 'InvalidRequest';
  }
  for (const name of signedHeaders) {
    if (request.headers[name] === undefined) return 'SignatureDoesNotMatch';
  }
  const expected = signature({
    method: request.method,
    url: request.url,
    headers: request.headers,
    signedHeaders,
    secretAccessKey: credentials.secretAccessKey,
    region: region!,
    service: service!,
    amzDate,
  });
  const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(given!));
  return ok ? null : 'SignatureDoesNotMatch';
}
