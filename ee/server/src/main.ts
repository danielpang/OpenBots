// The managed OpenBots server (plan 21.5): the core server, extended with
// organizations. Needs OPENBOT_DEPLOYMENT=managed.
import { runServer } from '@openbot/server/server';
import { emailFromEnv, managedExtensions } from './index.js';

if (process.env.OPENBOT_DEPLOYMENT !== 'managed') {
  throw new Error('The managed server needs OPENBOT_DEPLOYMENT=managed');
}

await runServer(managedExtensions({ email: emailFromEnv() }));
