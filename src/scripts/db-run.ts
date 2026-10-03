/**
 * Apply ONE SQL file to the database, inside a single transaction:
 *   npm run db:run -- database/migrations/2026-10-03-example.sql
 *
 * Unlike `db:pipeline` (which re-runs schema.sql, every migration and seed.sql),
 * this touches nothing but the file you name — the safe way to push a single
 * migration to a live database. Any error rolls the whole file back.
 *
 * Required env:
 *   SUPABASE_DB_URL=postgresql://...   (Session pooler URI)
 *
 * Optional flags:
 *   --dry-run  Run the file, then roll back instead of committing (checks it applies cleanly).
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Client } from 'pg';

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

const main = async () => {
  if (!file) throw new Error('Name the SQL file to run, e.g. npm run db:run -- database/migrations/2026-10-03-example.sql');
  const filePath = path.resolve(file);
  if (!existsSync(filePath)) throw new Error(`No such file: ${filePath}`);

  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('SUPABASE_DB_URL is not set in .env.');

  const sql = readFileSync(filePath, 'utf8');
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await client.connect();
  console.log(`${dryRun ? 'Dry run' : 'Applying'}: ${path.relative(process.cwd(), filePath)} (host ${new URL(connectionString).hostname})`);

  try {
    await client.query('begin');
    await client.query(sql);
    await client.query(dryRun ? 'rollback' : 'commit');
    console.log(dryRun ? 'Applied cleanly, then rolled back. Nothing was changed.' : 'Committed.');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
};

main().catch((error) => {
  console.error(`Failed — nothing was changed. ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
