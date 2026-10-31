import { ApiError } from '@openbot/api-client';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQuery } from '../app/api.js';
import { loadDeployment } from '../app/deployment.js';
import { setupQuery, setupRequired } from '../features/setup/api.js';
import { Shell } from '../app/shell.js';

// Every signed-in page sits under this pathless layout. It loads the caller
// and the install's deployment (self-hosted or managed), which decides
// whether anything about admins, members or the audit log shows.

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context }) => {
    try {
      const [me, deployment] = await Promise.all([
        context.queryClient.ensureQueryData(meQuery),
        loadDeployment(context.queryClient),
      ]);
      return { me, deployment };
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        // A new install has nobody to sign in as: the first-run wizard creates the owner.
        const setup = await setupRequired(() => context.queryClient.fetchQuery(setupQuery));
        throw redirect({ to: setup ? '/setup' : '/sign-in' });
      }
      throw error;
    }
  },
  component: Shell,
});
