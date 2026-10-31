// `docker compose run --rm openbot rotate-key` (or `pnpm --filter
// @openbot/server rotate-key`): re-seals every stored secret under
// OPENBOT_MASTER_KEY, opening old ones with OPENBOT_MASTER_KEY_PREVIOUS (plan
// 4.9). Safe to stop and run again. Exits 1 while any secret is left that no
// configured key opens.
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { rotateMasterKey } from './rotation.js';

const config = loadConfig();
const db = createDb(config.databaseUrl, { max: 1 });
if (!config.previousMasterKeys.length) {
  console.log(
    'rotate-key: OPENBOT_MASTER_KEY_PREVIOUS is empty; checking every secret opens with OPENBOT_MASTER_KEY',
  );
}
try {
  const report = await rotateMasterKey({
    db,
    config,
    onProgress: (p) =>
      console.log(`rotate-key: ${p.column}: ${p.checked} checked, ${p.resealed} re-sealed`),
  });
  for (const f of report.failed) console.error(`rotate-key: ${f.column} ${f.id}: ${f.error}`);
  console.log(
    `rotate-key: done. ${report.resealed} re-sealed, ${report.current} already under the current key, ${report.failed.length} not opened`,
  );
  if (report.failed.length) {
    console.error(
      'rotate-key: keep OPENBOT_MASTER_KEY_PREVIOUS until the secrets above are re-entered or deleted',
    );
    process.exitCode = 1;
  } else if (config.previousMasterKeys.length) {
    console.log(
      'rotate-key: every secret is under the current key; OPENBOT_MASTER_KEY_PREVIOUS can be removed',
    );
  }
} finally {
  await db.close();
}
