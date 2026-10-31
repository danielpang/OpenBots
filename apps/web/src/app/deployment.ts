import type { components } from '@openbot/api-client';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { capabilitiesQuery } from './api.js';

// What kind of install the server is (OPENBOT_DEPLOYMENT, in
// /api/v1/capabilities). Self-hosted, the default, is one person's: one
// account, its owner, so there is no Admin or Audit log tab, no invites or
// members, and no "admin" wording. The managed OpenBots service keeps all of
// it. The owner is an admin internally, so role checks still pass for them.

export type Deployment = components['schemas']['Capabilities']['deployment'];

type Capabilities = components['schemas']['Capabilities'];

const deploymentOf = (capabilities: Capabilities | undefined): Deployment =>
  capabilities?.deployment ?? 'self_hosted';

/**
 * The deployment, for route guards. Loads the capabilities once; a server
 * that cannot be asked counts as self-hosted, so nothing admin shows by mistake.
 */
export async function loadDeployment(queryClient: QueryClient): Promise<Deployment> {
  try {
    return deploymentOf(await queryClient.ensureQueryData(capabilitiesQuery));
  } catch {
    return 'self_hosted';
  }
}

/**
 * Whether this is the managed service. Reads the capabilities the app routes
 * loaded before rendering and never fetches them itself; without them it
 * answers false, as for a self-hosted install.
 */
export function useManaged(): boolean {
  const { data } = useQuery({ ...capabilitiesQuery, enabled: false });
  return deploymentOf(data) === 'managed';
}

/** What a blocked connector or tool says: on a self-hosted install the owner set the policy. */
export const blockedText = (managed: boolean) =>
  managed ? 'Disabled by admin' : 'Blocked by policy';

/** "Admin: <label>" on the managed service; just the label, capitalised, when self-hosted. */
export function adminLabel(managed: boolean, label: string): string {
  return managed ? `Admin: ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
}
