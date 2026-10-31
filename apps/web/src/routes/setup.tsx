import { createFileRoute, redirect } from '@tanstack/react-router';
import { setupQuery, setupRequired } from '../features/setup/api.js';
import { SetupWizard } from '../features/setup/setup-wizard.js';

// Shown only while no user exists; afterwards /setup goes to the app.

export const Route = createFileRoute('/setup')({
  beforeLoad: async ({ context }) => {
    if (!(await setupRequired(() => context.queryClient.fetchQuery(setupQuery)))) {
      throw redirect({ to: '/' });
    }
  },
  component: SetupWizard,
});
