/**
 * Apply the database pipeline in one command:
 *   npm run db:pipeline
 *
 * Required env:
 *   SUPABASE_DB_URL=postgresql://...
 *
 * Optional flags:
 *   --dry-run  Print the SQL files in order without connecting.
 *   --demo     Also apply database/seed-demo.sql after seed.sql.
 */
import dotenv from 'dotenv';
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { Client, type ClientConfig } from 'pg';

dotenv.config();

type SqlStep = {
  label: string;
  filePath: string;
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeDemo = args.has('--demo') || process.env.DB_PIPELINE_INCLUDE_DEMO === 'true';

const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;

const findDatabaseDir = () => {
  const candidates = [
    process.env.DATABASE_DIR,
    path.join(process.cwd(), '..', 'database'),
    path.join(process.cwd(), 'database'),
    '/database'
  ].filter(Boolean) as string[];

  const found = candidates.find((candidate) => existsSync(path.join(path.resolve(candidate), 'schema.sql')));
  if (!found) {
    throw new Error(`Could not find database/schema.sql. Checked: ${candidates.map((candidate) => path.resolve(candidate)).join(', ')}`);
  }

  return path.resolve(found);
};

const databaseDir = findDatabaseDir();
const migrationsDir = path.join(databaseDir, 'migrations');

const requireFile = (filePath: string, label: string): SqlStep => {
  if (!existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }

  return { label, filePath };
};

const getMigrationSteps = (): SqlStep[] => {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Missing migrations directory: ${migrationsDir}`);
  }

  return readdirSync(migrationsDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .filter((fileName) => fileName !== '000-apply-all.sql')
    .sort((a, b) => a.localeCompare(b))
    .map((fileName) => ({
      label: `migration:${fileName}`,
      filePath: path.join(migrationsDir, fileName)
    }));
};

const getPipeline = (): SqlStep[] => {
  const steps: SqlStep[] = [
    requireFile(path.join(databaseDir, 'schema.sql'), 'schema.sql'),
    ...getMigrationSteps(),
    requireFile(path.join(databaseDir, 'seed.sql'), 'seed.sql')
  ];

  if (includeDemo) {
    steps.push(requireFile(path.join(databaseDir, 'seed-demo.sql'), 'seed-demo.sql'));
  }

  return steps;
};

const getClientConfig = (): ClientConfig => {
  if (!connectionString) {
    throw new Error('Set SUPABASE_DB_URL, DATABASE_URL, or POSTGRES_URL before running the database pipeline.');
  }

  const sslMode = process.env.PGSSLMODE?.trim().toLowerCase();
  const usesLocalhost = /@(?:localhost|127\.0\.0\.1)(?::|\/)/.test(connectionString);

  return {
    connectionString,
    ssl: sslMode === 'disable' || usesLocalhost ? false : { rejectUnauthorized: false }
  };
};

const runStep = async (client: Client, step: SqlStep, index: number, total: number) => {
  const sql = readFileSync(step.filePath, 'utf8');
  const relativePath = path.relative(databaseDir, step.filePath);

  console.log(`[${index}/${total}] Applying ${relativePath}`);

  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[${index}/${total}] Done ${relativePath}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};

const main = async () => {
  const steps = getPipeline();

  console.log(`Database directory: ${databaseDir}`);
  console.log('Pipeline order:');
  for (const [index, step] of steps.entries()) {
    console.log(`  ${index + 1}. ${path.relative(databaseDir, step.filePath)}`);
  }

  if (dryRun) {
    console.log('Dry run complete. No SQL was applied.');
    return;
  }

  const client = new Client(getClientConfig());
  await client.connect();

  try {
    for (const [index, step] of steps.entries()) {
      await runStep(client, step, index + 1, steps.length);
    }
  } finally {
    await client.end();
  }

  console.log('Database pipeline completed successfully.');
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Database pipeline failed: ${message}`);
  process.exit(1);
});
