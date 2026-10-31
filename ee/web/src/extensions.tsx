import { isAdmin, type WebExtensions } from '@openbot/web/extensions';
import { AuditLog } from './audit-log.js';
import { MembersSettings } from './members.js';
import { Onboarding } from './onboarding.js';
import { OrganizationSettings } from './organization-settings.js';
import { OrganizationSwitcher } from './switcher.js';

// What the managed web app adds to the core app (plan 21.5): the switcher,
// onboarding (create an organization, or join through an invite), and the
// organization's settings. Model providers at both levels are the core's
// Settings > Models, which shows "Organization" and "Yours" here.

export const managedWeb: WebExtensions = {
  SidebarHeader: OrganizationSwitcher,
  Onboarding,
  settingsTabs: [
    {
      section: 'organization',
      label: 'Organization',
      visible: () => true,
      Component: OrganizationSettings,
    },
    {
      section: 'members',
      label: 'Members',
      visible: (me) => isAdmin(me.role),
      Component: MembersSettings,
    },
    {
      section: 'audit',
      label: 'Audit log',
      visible: (me) => isAdmin(me.role),
      Component: AuditLog,
    },
  ],
};
