import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from './db.js';
import { requireStaff, requireUser } from './auth.js';

type CurrentUser = {
  id: number;
  username: string;
  password_hash: string;
  role: 'driver' | 'dispatcher' | 'manager' | 'admin' | 'owner';
};

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200)
});

const resetPasswordSchema = z.object({
  temporaryPassword: z.string().min(12).max(200)
});

const activeSchema = z.object({ isActive: z.boolean() });

const idParams = z.object({ id: z.coerce.number().int().positive() });

function currentUser(request: FastifyRequest): CurrentUser {
  return (request as any).sterlingUser as CurrentUser;
}

async function revokeAllSessions(connection: any, userId: number) {
  await connection.execute(
    `UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, NOW(3)) WHERE user_id = ?`,
    [userId]
  );
}

export async function registerAccountManagementRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v2/auth/change-password', { preHandler: requireUser }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_password_change' });

    const user = currentUser(request);
    const valid = await argon2.verify(user.password_hash, parsed.data.currentPassword).catch(() => false);
    if (!valid) return reply.code(401).send({ error: 'current_password_incorrect' });

    const same = await argon2.verify(user.password_hash, parsed.data.newPassword).catch(() => false);
    if (same) return reply.code(400).send({ error: 'new_password_must_differ' });

    const passwordHash = await argon2.hash(parsed.data.newPassword, { type: argon2.argon2id });

    await withTransaction(async (connection) => {
      await connection.execute(
        `UPDATE users
            SET password_hash = ?, must_change_password = 0, token_version = token_version + 1
          WHERE id = ?`,
        [passwordHash, user.id]
      );
      await revokeAllSessions(connection, user.id);
      await connection.execute(
        `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id)
         VALUES (?, ?, 'auth.password_changed', 'user', ?)`,
        [user.id, user.id, String(user.id)]
      );
    });

    return { ok: true, reloginRequired: true };
  });

  app.get('/api/v2/staff/drivers', { preHandler: requireStaff(['dispatcher', 'manager', 'admin', 'owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT id, username, display_name AS displayName, role, rank_name AS rankName,
              is_active AS isActive, must_change_password AS mustChangePassword, created_at AS createdAt
         FROM users
        WHERE role = 'driver'
        ORDER BY display_name, id`
    );
    return { drivers: rows.map((row) => ({ ...row, isActive: Boolean(row.isActive), mustChangePassword: Boolean(row.mustChangePassword) })) };
  });

  app.post('/api/v2/staff/drivers/:id/reset-password', { preHandler: requireStaff(['manager', 'admin', 'owner']) }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = resetPasswordSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });

    const actor = currentUser(request);
    const passwordHash = await argon2.hash(body.data.temporaryPassword, { type: argon2.argon2id });

    const changed = await withTransaction(async (connection) => {
      const [result] = await connection.execute<any>(
        `UPDATE users
            SET password_hash = ?, must_change_password = 1, token_version = token_version + 1
          WHERE id = ? AND role = 'driver'`,
        [passwordHash, params.data.id]
      );
      if (result.affectedRows !== 1) return false;
      await revokeAllSessions(connection, params.data.id);
      await connection.execute(
        `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id)
         VALUES (?, ?, 'driver.password_reset', 'user', ?)`,
        [actor.id, params.data.id, String(params.data.id)]
      );
      return true;
    });

    if (!changed) return reply.code(404).send({ error: 'driver_not_found' });
    return { ok: true };
  });

  app.patch('/api/v2/staff/drivers/:id/active', { preHandler: requireStaff(['manager', 'admin', 'owner']) }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = activeSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });

    const actor = currentUser(request);
    const changed = await withTransaction(async (connection) => {
      const [result] = await connection.execute<any>(
        `UPDATE users
            SET is_active = ?, token_version = token_version + 1
          WHERE id = ? AND role = 'driver'`,
        [body.data.isActive ? 1 : 0, params.data.id]
      );
      if (result.affectedRows !== 1) return false;
      if (!body.data.isActive) await revokeAllSessions(connection, params.data.id);
      await connection.execute(
        `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id, metadata)
         VALUES (?, ?, ?, 'user', ?, JSON_OBJECT('isActive', ?))`,
        [actor.id, params.data.id, body.data.isActive ? 'driver.enabled' : 'driver.disabled', String(params.data.id), body.data.isActive]
      );
      return true;
    });

    if (!changed) return reply.code(404).send({ error: 'driver_not_found' });
    return { ok: true, isActive: body.data.isActive };
  });
}
