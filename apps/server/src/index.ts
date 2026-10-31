import { packageName } from '@openbot/shared';

// The server package. The managed build (ee/server) imports the core through
// its subpath exports (`@openbot/server/server`, `@openbot/server/db/client`,
// and so on) and extends it through `ServerExtensions` (plan 21.5).

export const PACKAGE_NAME = packageName('server');
export type { ServerExtensions, ExtensionContext } from './extensions.js';
