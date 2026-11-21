import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { AGENT_TOKEN_HEADER } from './protocol.js';

// One shared token guards every endpoint. HTTP sends `Authorization: Bearer`,
// or `X-OpenBots-Agent-Token` where a proxy in front of the agent keeps
// `Authorization` for itself (a private Sprite URL); a WebSocket upgrade may
// send either header or, where a client cannot set headers, a `token` query
// parameter.

const digest = (value: string) => createHash('sha256').update(value).digest();

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

export function bearer(header: string | undefined | null): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * Whether a request carries the token in either header. Both are checked: in
 * front of a private Sprite URL, `Authorization` may still hold the proxy's
 * own token when it reaches the agent.
 */
export function headersAuthorized(
  expected: string,
  authorization: string | undefined | null,
  agentToken: string | undefined | null,
): boolean {
  return tokenMatches(expected, bearer(authorization)) || tokenMatches(expected, agentToken);
}

export function upgradeAuthorized(
  expected: string,
  headers: IncomingHttpHeaders,
  url: URL,
): boolean {
  const header = headers[AGENT_TOKEN_HEADER];
  return (
    headersAuthorized(
      expected,
      headers.authorization,
      Array.isArray(header) ? undefined : header,
    ) || tokenMatches(expected, url.searchParams.get('token'))
  );
}
