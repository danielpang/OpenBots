// `pnpm --filter @openbot/server db:migrate`: applies migrations to DATABASE_URL
// (or the file in DATABASE_URL_FILE).
import { secretFromEnv } from '../env-files.js';
import { createDb } from './client.js';
import { migrate } from './migrate.js';

const url = secretFromEnv('DATABASE_URL');
if (!url) {
  console.error('db:migrate: DATABASE_URL is not set');
  process.exit(1);
}

const db = createDb(url);
try {
  await migrate(db);
  console.log('db:migrate: up to date');
} finally {
  await db.close();
}
