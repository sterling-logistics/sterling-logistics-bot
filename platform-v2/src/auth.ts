import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { db, withTransaction } from './db.js';

export type Role = 'driver' | 'dispatcher' | 'manager' | 'admin' | 'owner';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: Role;
  rank_name: string;
  is_active: number;
  must_change_password: number;
  token_version: number;
};

const loginSchema = z.object({
  username: z.string().trim().min(3).max(40),
  password: z.string().min(8).max(200)
});

const refreshSchema = z.object({ refreshToken: z.string().min(40) });

const createDriverSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/),
  temporaryPassword: z.string().min(12).max(200),
  displayName: z.string().trim().min(2).max(100),
  rankName: z.string().trim().min(2).max(80).default('Driver')
});

function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    rankName: user.rank_name,
    mustChangePassword: Boolean(user.must_change_password)
  };
}

async function findUserByUsername(username: string): Promise<UserRow | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id, username, password_hash, display_name, role, rank_name, is_active, must_change_password, token_version
       FROM users WHERE username = ? LIMIT 1`,
    [username.toLowerCase()]
  );
  return (rows[0] as UserRow | undefined) ?? null;
}

async function findUserById(id: number): Promise<UserRow | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id, username, password_hash, display_name, role, rank_name, is_active, must_change_password, token_version
       FROM users WHERE id = ? LIMIT 1`,
    [id]
  );
  return (rows[0] as UserRow | undefined) ?? null;
}

function issueAccessToken(app: FastifyInstance, user: UserRow): string {
  return app.jwt.sign(
    { sub: String(user.id), role: user.role, ver: user.token_version },
    { expiresIn: config.ACCESS_TOKEN_TTL as any }
  );
}

async function createRefreshSession(userId: number, request: FastifyRequest): Promise<string> {
  const raw = randomBytes(48).toString('base64url');
  const hash = hashOpaqueToken(raw);
  const id = randomUUID();
  const expires = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000);
  const ip = request.ip?.slice(0, 45) ?? null;
  const agent = String(request.headers['user-agent'] ?? '').slice(0, 255) || null;

  await db.execute(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, hash, expires, ip, agent]
  );
  return raw;
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
    const payload = request.user as { sub?: string; role?: Role; ver?: number };
    const userId = Number(payload.sub);
    if (!Number.isSafeInteger(userId)) throw new Error('invalid subject');
    const user = await findUserById(userId);
    if (!user || !user.is_active || user.token_version !== payload.ver) {
      return void reply.code(401).send({ error: 'session_invalid' });
    }
    (request as any).sterlingUser = user;
  } catch {
    return void reply.code(401).send({ error: 'unauthorised' });
  }
}

export function requireStaff(minimum: Role[] = ['dispatcher', 'manager', 'admin', 'owner']) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireUser(request, reply);
    if (reply.sent) return;
    const user = (request as any).sterlingUser as UserRow;
    if (!minimum.includes(user.role)) {
      return void reply.code(403).send({ error: 'forbidden' });
    }
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v2/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_credentials' });

    const user = await findUserByUsername(parsed.data.username);
    if (!user || !user.is_active) return reply.code(401).send({ error: 'invalid_credentials' });

    const valid = await argon2.verify(user.password_hash, parsed.data.password).catch(() => false);
    if (!valid) return reply.code(401).send({ error: 'invalid_credentials' });

    const refreshToken = await createRefreshSession(user.id, request);
    const accessToken = issueAccessToken(app, user);
    await db.execute(
      `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, metadata)
       VALUES (?, ?, 'auth.login', JSON_OBJECT('ip', ?))`,
      [user.id, user.id, request.ip]
    );

    return { accessToken, refreshToken, user: publicUser(user) };
  });

  app.post('/api/v2/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_refresh_token' });
    const oldHash = hashOpaqueToken(parsed.data.refreshToken);

    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(
        `SELECT s.id AS session_id, s.user_id, u.id, u.username, u.password_hash, u.display_name,
                u.role, u.rank_name, u.is_active, u.must_change_password, u.token_version
           FROM refresh_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > NOW(3)
          LIMIT 1 FOR UPDATE`,
        [oldHash]
      );
      const row = rows[0];
      if (!row || !row.is_active) return null;

      await connection.execute(`UPDATE refresh_sessions SET revoked_at = NOW(3), last_used_at = NOW(3) WHERE id = ?`, [row.session_id]);

      const raw = randomBytes(48).toString('base64url');
      const newHash = hashOpaqueToken(raw);
      const newId = randomUUID();
      const expires = new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000);
      await connection.execute(
        `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, row.user_id, newHash, expires, request.ip.slice(0, 45), String(request.headers['user-agent'] ?? '').slice(0, 255)]
      );
      return { user: row as UserRow, refreshToken: raw };
    });

    if (!result) return reply.code(401).send({ error: 'invalid_refresh_token' });
    return {
      accessToken: issueAccessToken(app, result.user),
      refreshToken: result.refreshToken,
      user: publicUser(result.user)
    };
  });

  app.post('/api/v2/auth/logout', { preHandler: requireUser }, async (request) => {
    const body = refreshSchema.safeParse(request.body);
    if (body.success) {
      await db.execute(`UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, NOW(3)) WHERE token_hash = ?`, [hashOpaqueToken(body.data.refreshToken)]);
    }
    return { ok: true };
  });

  app.get('/api/v2/auth/me', { preHandler: requireUser }, async (request) => {
    return { user: publicUser((request as any).sterlingUser as UserRow) };
  });

  app.post('/api/v2/staff/drivers', { preHandler: requireStaff(['manager', 'admin', 'owner']) }, async (request, reply) => {
    const parsed = createDriverSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_driver', details: parsed.error.flatten() });

    const actor = (request as any).sterlingUser as UserRow;
    const passwordHash = await argon2.hash(parsed.data.temporaryPassword, { type: argon2.argon2id });

    try {
      const [result] = await db.execute<any>(
        `INSERT INTO users (username, password_hash, display_name, role, rank_name, must_change_password)
         VALUES (?, ?, ?, 'driver', ?, 1)`,
        [parsed.data.username, passwordHash, parsed.data.displayName, parsed.data.rankName]
      );
      const driverId = Number(result.insertId);
      await db.execute(
        `INSERT INTO audit_events (actor_user_id, target_user_id, event_type, entity_type, entity_id)
         VALUES (?, ?, 'driver.created', 'user', ?)`,
        [actor.id, driverId, String(driverId)]
      );
      return reply.code(201).send({ id: driverId, username: parsed.data.username, displayName: parsed.data.displayName, rankName: parsed.data.rankName });
    } catch (error: any) {
      if (error?.code === 'ER_DUP_ENTRY') return reply.code(409).send({ error: 'username_exists' });
      throw error;
    }
  });
}
