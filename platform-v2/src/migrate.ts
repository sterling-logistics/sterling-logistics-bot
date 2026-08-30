import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { config } from './config.js';

async function main() {
  const migrationsDir = resolve(process.cwd(), 'migrations');
  const files = (await readdir(migrationsDir))
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) throw new Error('No Sterling V2 migrations were found.');

  const connection = await mysql.createConnection({
    uri: config.DATABASE_URL,
    multipleStatements: true,
    decimalNumbers: true
  });

  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) NOT NULL PRIMARY KEY,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB
    `);

    for (const filename of files) {
      const sql = await readFile(resolve(migrationsDir, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const [rows] = await connection.query<any[]>(
        'SELECT checksum FROM schema_migrations WHERE filename = ? LIMIT 1',
        [filename]
      );

      if (rows[0]) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`Migration ${filename} has changed after being applied. Refusing to continue.`);
        }
        console.log(`SKIP ${filename}`);
        continue;
      }

      console.log(`APPLY ${filename}`);
      await connection.beginTransaction();
      try {
        await connection.query(sql);
        await connection.execute(
          'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
          [filename, checksum]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    console.log(`Sterling Platform V2 database is current (${files.length} migrations known).`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
