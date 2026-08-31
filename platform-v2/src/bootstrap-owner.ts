import 'dotenv/config';
import argon2 from 'argon2';
import { z } from 'zod';
import { db } from './db.js';

const schema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
  password: z.string().min(16).max(200),
  displayName: z.string().trim().min(2).max(100)
});

async function main() {
  const parsed = schema.safeParse({
    username: process.env.STERLING_OWNER_USERNAME,
    password: process.env.STERLING_OWNER_PASSWORD,
    displayName: process.env.STERLING_OWNER_DISPLAY_NAME ?? 'Owner / Founder'
  });

  if (!parsed.success) {
    throw new Error('Set STERLING_OWNER_USERNAME, STERLING_OWNER_PASSWORD (minimum 16 characters), and optionally STERLING_OWNER_DISPLAY_NAME.');
  }

  const [owners] = await db.query<any[]>(`SELECT id, username FROM users WHERE role = 'owner' LIMIT 1`);
  if (owners[0]) {
    throw new Error(`Owner account already exists (${owners[0].username}). Bootstrap will not overwrite it.`);
  }

  const [duplicate] = await db.query<any[]>(`SELECT id FROM users WHERE username = ? LIMIT 1`, [parsed.data.username]);
  if (duplicate[0]) throw new Error('That username already exists. Choose another Owner username.');

  const passwordHash = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
  const [result] = await db.execute<any>(
    `INSERT INTO users (username, password_hash, display_name, role, rank_name, is_active, must_change_password)
     VALUES (?, ?, ?, 'owner', 'Owner / Founder', 1, 0)`,
    [parsed.data.username, passwordHash, parsed.data.displayName]
  );
  const ownerId = Number(result.insertId);
  await db.execute(
    `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id)
     VALUES (?, ?, 'owner.bootstrap_created', 'user', ?)`,
    [ownerId, ownerId, String(ownerId)]
  );
  console.log(`Sterling Owner/Founder account created: ${parsed.data.username}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
