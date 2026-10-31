// `pnpm --filter @openbot/server keygen`: prints a fresh OPENBOT_MASTER_KEY.
import { generateMasterKey } from './secrets.js';

console.log(generateMasterKey());
