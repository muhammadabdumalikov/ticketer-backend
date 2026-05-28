import 'dotenv/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
// kysely 0.29 ships Migrator behind a subpath export. Node honors `exports`
// at runtime but TS's `node` moduleResolution doesn't — load via require()
// and import the types via the dist path.
import type {
  Migration,
  MigrationProvider,
  Migrator as MigratorType,
} from 'kysely/dist/migration/migrator';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Migrator } = require('kysely/migration') as { Migrator: typeof MigratorType };
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

/**
 * Custom provider that uses CommonJS `require()` so ts-node can compile .ts
 * migration files. Kysely's built-in FileMigrationProvider uses ESM dynamic
 * import() which doesn't get transpiled by ts-node's CJS hook.
 */
class TsRequireMigrationProvider implements MigrationProvider {
  constructor(private readonly folder: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = await fs.readdir(this.folder);
    const migrations: Record<string, Migration> = {};
    for (const file of files.sort()) {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
      const name = file.replace(/\.(ts|js)$/, '');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(this.folder, file));
      migrations[name] = mod as Migration;
    }
    return migrations;
  }
}

function makeDb(): Kysely<any> {
  const connectionString =
    process.env.DATABASE_URL ??
    'postgresql://ticketer:ticketer@localhost:5432/ticketer';
  return new Kysely<any>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  });
}

async function latest(): Promise<void> {
  const db = makeDb();
  const migrator = new Migrator({
    db,
    provider: new TsRequireMigrationProvider(MIGRATIONS_DIR),
  });
  const { error, results } = await migrator.migrateToLatest();
  results?.forEach((r) =>
    console.log(
      r.status === 'Success'
        ? `✅ ${r.migrationName}`
        : r.status === 'Error'
          ? `❌ ${r.migrationName}`
          : `⏭  ${r.migrationName}`,
    ),
  );
  await db.destroy();
  if (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

async function down(): Promise<void> {
  const db = makeDb();
  const migrator = new Migrator({
    db,
    provider: new TsRequireMigrationProvider(MIGRATIONS_DIR),
  });
  const { error, results } = await migrator.migrateDown();
  results?.forEach((r) => console.log(`${r.status} — ${r.migrationName}`));
  await db.destroy();
  if (error) {
    console.error('Rollback failed:', error);
    process.exit(1);
  }
}

async function create(name: string): Promise<void> {
  if (!name) {
    console.error('Usage: pnpm db:migrate:new <name>');
    process.exit(1);
  }
  const stamp = String(Date.now());
  const file = path.join(MIGRATIONS_DIR, `${stamp}_${name}.ts`);
  await fs.writeFile(
    file,
    `import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // TODO
}

export async function down(db: Kysely<any>): Promise<void> {
  // TODO
}
`,
  );
  console.log(`Created ${path.relative(process.cwd(), file)}`);
}

const [, , cmd, ...rest] = process.argv;
const handlers: Record<string, () => Promise<void>> = {
  latest,
  down,
  new: () => create(rest[0]),
};
const handler = handlers[cmd];
if (!handler) {
  console.error(
    `Unknown command "${cmd}". Use: latest | down | new <name>`,
  );
  process.exit(1);
}
handler().catch((err) => {
  console.error(err);
  process.exit(1);
});
