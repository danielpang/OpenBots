import { createFileRoute, redirect } from '@tanstack/react-router';
import { AdminSettings } from '../../../features/settings/admin-settings.js';
import { MembersSettings } from '../../../features/settings/members.js';

// The managed service's admins only; a self-hosted install has no Admin tab.

export const Route = createFileRoute('/_app/settings/admin')({
  beforeLoad: ({ context }) => {
    if (context.me.role !== 'admin' || context.deployment !== 'managed') {
      throw redirect({ to: '/settings/account' });
    }
  },
  component: Admin,
});

function Admin() {
  return (
    <div className="flex flex-col gap-10">
      <AdminSettings />
      <MembersSettings />
    </div>
  );
}
