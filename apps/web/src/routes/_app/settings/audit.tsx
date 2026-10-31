import { createFileRoute, redirect } from '@tanstack/react-router';
import { AuditLog } from '../../../features/settings/audit-log.js';

// The managed service's admins only; a self-hosted install has no audit log tab.

export const Route = createFileRoute('/_app/settings/audit')({
  beforeLoad: ({ context }) => {
    if (context.me.role !== 'admin' || context.deployment !== 'managed') {
      throw redirect({ to: '/settings/account' });
    }
  },
  component: AuditLog,
});
