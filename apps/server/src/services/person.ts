import type { CurrentUser } from '../context.js';
import type { Db } from '../db/client.js';
import { DomainError } from '../errors.js';
import { isDeviceKey } from './devices.js';

// Some things only a person may do: an API key is a script's, and so is
// anything a Bot could hold. A person is a signed-in session, or a device
// the member paired themselves (the phone, the Mac app), whose key the
// server issued to that device alone.

/** 403 `PERSON_REQUIRED`, saying what only a person may do. */
export const personRequired = (what: string) =>
  new DomainError(
    403,
    'PERSON_REQUIRED',
    `Only a person can ${what}: use the app or a paired device. An API key cannot.`,
  );

/**
 * Throws `PERSON_REQUIRED` unless a person is behind the request: a session
 * (no API key), or a paired device's key. Call in the organization's scope.
 */
export async function assertPerson(
  db: Db,
  caller: Pick<CurrentUser, 'workspaceId'> & { apiKeyId?: string | null },
  what: string,
): Promise<void> {
  if (!caller.apiKeyId) return;
  if (await isDeviceKey(db, { workspaceId: caller.workspaceId, apiKeyId: caller.apiKeyId })) {
    return;
  }
  throw personRequired(what);
}
