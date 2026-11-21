import type { EventBus } from '@openbots/shared';

// When an API key stops working (`DELETE /api-keys/{id}`, or a device's key
// when the device is revoked), or a revoked device's session does, every API
// instance closes the realtime,
// terminal and screen sockets that authenticated with it (ws/gateway.ts,
// ws/computer.ts). Those sockets checked the key only at their upgrade; this
// closes them at once. Without a shared bus (no REDIS_URL) a revocation in
// another process is not heard, so each socket's key is also looked up again
// every minute (ws/key-watch.ts).

/** The bus channel that tells API instances an API key is gone. */
export const API_KEY_REVOKED_CHANNEL = 'openbots:api-key-revoked';

/**
 * One of the two: an API key, or the session of a Mac app signed in through
 * the browser, whose device was revoked (services/devices.ts). A message
 * with only `sessionId` is ignored by a server from before it.
 */
export interface ApiKeyRevoked {
  apiKeyId?: string;
  sessionId?: string;
}

export function announceApiKeyRevoked(bus: EventBus, apiKeyId: string): Promise<void> {
  return bus.publish<ApiKeyRevoked>(API_KEY_REVOKED_CHANNEL, { apiKeyId });
}

/** A device's session was deleted: close the sockets it opened. */
export function announceSessionRevoked(bus: EventBus, sessionId: string): Promise<void> {
  return bus.publish<ApiKeyRevoked>(API_KEY_REVOKED_CHANNEL, { sessionId });
}
