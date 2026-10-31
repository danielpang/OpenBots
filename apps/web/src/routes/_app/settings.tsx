import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { Page } from '../../app/page.js';

export const Route = createFileRoute('/_app/settings')({
  component: Settings,
});

// The active tab looks like the sidebar's active link. It goes through the
// Link's `data-status`, because a variant beats the base text colour where a
// second plain colour class may not.
const TAB_CLASS =
  'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground';

/**
 * The tabs a caller gets. Admin and Audit log are for the managed service's
 * admins. A self-hosted install has one owner and neither tab; its owner
 * changes the limits, which managed admins find under Admin, in Limits. In
 * the Mac app's local mode there is no account: General, with the owner's
 * name, takes Account's place.
 */
function settingsTabs(admin: boolean, managed: boolean, localAuth: boolean) {
  return [
    localAuth
      ? ({ to: '/settings/general', label: 'General' } as const)
      : ({ to: '/settings/account', label: 'Account' } as const),
    { to: '/settings/models', label: 'Models' },
    { to: '/settings/events', label: 'Events' },
    ...(admin && !managed ? ([{ to: '/settings/limits', label: 'Limits' }] as const) : []),
    ...(admin && managed
      ? ([
          { to: '/settings/admin', label: 'Admin' },
          { to: '/settings/audit', label: 'Audit log' },
        ] as const)
      : []),
  ] as const;
}

function Settings() {
  const { me, deployment, localAuth } = Route.useRouteContext();
  const tabs = settingsTabs(me.role === 'admin', deployment === 'managed', localAuth);

  return (
    <Page title="Settings">
      <div role="tablist" className="flex gap-1 border-b pb-2">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            role="tab"
            className={TAB_CLASS}
            activeProps={{ 'aria-selected': true }}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      <Outlet />
    </Page>
  );
}
