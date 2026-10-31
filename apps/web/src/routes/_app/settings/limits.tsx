import { createFileRoute, redirect } from '@tanstack/react-router';
import { LimitsSettings } from '../../../features/settings/admin-settings.js';

// A self-hosted owner's limits. The managed service keeps them under Admin.

export const Route = createFileRoute('/_app/settings/limits')({
  beforeLoad: ({ context }) => {
    if (context.deployment === 'managed') throw redirect({ to: '/settings/admin' });
    if (context.me.role !== 'admin') throw redirect({ to: '/settings/account' });
  },
  component: LimitsSettings,
});
