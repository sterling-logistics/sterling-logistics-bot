import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from './db.js';
import { requireStaff } from './auth.js';

type CurrentUser = {
  id: number;
  username: string;
  role: 'driver' | 'dispatcher' | 'manager' | 'admin' | 'owner';
};

const resetPasswordSchema = z.object({
  password: z.string().min(12).max(200)
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
  // Driver passwords are Owner/Founder controlled. There is deliberately no
  // self-service change-password route in Platform V2.
  app.get('/api/v2/owner/drivers', { preHandler: requireStaff(['owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT id, username, display_name AS displayName, role, rank_name AS rankName,
              is_active AS isActive, created_at AS createdAt, updated_at AS updatedAt
         FROM users
        WHERE role IN ('driver','owner')
        ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, display_name, id`
    );
    return { drivers: rows.map((row) => ({ ...row, isActive: Boolean(row.isActive) })) };
  });

  app.post('/api/v2/owner/drivers/:id/set-password', { preHandler: requireStaff(['owner']) }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = resetPasswordSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });

    const actor = currentUser(request);
    const passwordHash = await argon2.hash(body.data.password, { type: argon2.argon2id });

    const changed = await withTransaction(async (connection) => {
      const [targetRows] = await connection.query<any[]>(
        `SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
        [params.data.id]
      );
      const target = targetRows[0];
      if (!target) return 'missing';
      if (target.role === 'owner' && target.id !== actor.id) return 'protected_owner';

      await connection.execute(
        `UPDATE users
            SET password_hash = ?, must_change_password = 0, token_version = token_version + 1
          WHERE id = ?`,
        [passwordHash, params.data.id]
      );
      await revokeAllSessions(connection, params.data.id);
      await connection.execute(
        `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id)
         VALUES (?, ?, 'owner.password_set', 'user', ?)`,
        [actor.id, params.data.id, String(params.data.id)]
      );
      return 'ok';
    });

    if (changed === 'missing') return reply.code(404).send({ error: 'driver_not_found' });
    if (changed === 'protected_owner') return reply.code(403).send({ error: 'owner_account_protected' });
    return { ok: true, reloginRequired: true };
  });

  app.patch('/api/v2/owner/drivers/:id/active', { preHandler: requireStaff(['owner']) }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = activeSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });

    const actor = currentUser(request);
    if (params.data.id === actor.id && !body.data.isActive) {
      return reply.code(400).send({ error: 'cannot_disable_current_owner' });
    }

    const changed = await withTransaction(async (connection) => {
      const [targetRows] = await connection.query<any[]>(
        `SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE`,
        [params.data.id]
      );
      const target = targetRows[0];
      if (!target) return 'missing';
      if (target.role === 'owner') return 'protected_owner';

      await connection.execute(
        `UPDATE users SET is_active = ?, token_version = token_version + 1 WHERE id = ?`,
        [body.data.isActive ? 1 : 0, params.data.id]
      );
      if (!body.data.isActive) await revokeAllSessions(connection, params.data.id);
      await connection.execute(
        `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id, metadata)
         VALUES (?, ?, ?, 'user', ?, JSON_OBJECT('isActive', ?))`,
        [actor.id, params.data.id, body.data.isActive ? 'driver.enabled' : 'driver.disabled', String(params.data.id), body.data.isActive]
      );
      return 'ok';
    });

    if (changed === 'missing') return reply.code(404).send({ error: 'driver_not_found' });
    if (changed === 'protected_owner') return reply.code(403).send({ error: 'owner_account_protected' });
    return { ok: true, isActive: body.data.isActive };
  });
}
