import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, withTransaction } from './db.js';
import { requireStaff, requireUser } from './auth.js';

type CurrentUser = { id: number; role: string };
type JobStatus = 'assigned' | 'in_progress' | 'submitted' | 'approved' | 'declined' | 'paid' | 'cancelled';

const createJobSchema = z.object({
  driverUserId: z.coerce.number().int().positive(),
  game: z.enum(['ets2', 'ats']),
  cargo: z.string().trim().min(1).max(160),
  originCity: z.string().trim().min(1).max(120),
  destinationCity: z.string().trim().min(1).max(120),
  distanceKm: z.coerce.number().min(0).max(100000).optional(),
  // ETS2/ATS money_account is stored as whole game-currency units. Keeping this
  // invariant at assignment prevents an approved payout that the Tracker cannot apply exactly.
  payoutAmount: z.coerce.number().int().min(0).max(100000000)
});

const submitSchema = z.object({
  clientSubmissionId: z.string().uuid(),
  distanceKm: z.coerce.number().min(0).max(100000),
  revenueGame: z.coerce.number().min(0).max(100000000000).optional()
});

const reviewSchema = z.object({ notes: z.string().trim().max(1000).optional() });
const publicIdParams = z.object({ id: z.string().uuid() });

function currentUser(request: FastifyRequest): CurrentUser {
  return (request as any).sterlingUser as CurrentUser;
}

async function event(connection: any, jobId: number, actorId: number | null, eventType: string, from: JobStatus | null, to: JobStatus | null, payload?: object) {
  await connection.execute(
    `INSERT INTO job_events (job_id, actor_user_id, event_type, from_status, to_status, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [jobId, actorId, eventType, from, to, payload ? JSON.stringify(payload) : null]
  );
}

async function createPayout(connection: any, job: { id: number; driver_user_id: number; payout_amount: number }, actorId: number, source: string) {
  const payoutPublicId = randomUUID();
  await connection.execute(
    `INSERT INTO payouts (public_id, job_id, driver_user_id, amount, status) VALUES (?, ?, ?, ?, 'pending')`,
    [payoutPublicId, job.id, job.driver_user_id, job.payout_amount]
  );
  const [payoutRows] = await connection.query(`SELECT id FROM payouts WHERE job_id = ? LIMIT 1`, [job.id]) as [any[], unknown];
  await connection.execute(
    `INSERT INTO payout_events (payout_id, event_type, payload) VALUES (?, 'payout.created', JSON_OBJECT('source', ?, 'actorId', ?))`,
    [payoutRows[0].id, source, actorId]
  );
  return payoutPublicId;
}

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v2/owner/jobs', { preHandler: requireStaff(['owner']) }, async (request, reply) => {
    const parsed = createJobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_job', details: parsed.error.flatten() });
    const actor = currentUser(request);
    const publicId = randomUUID();

    const result = await withTransaction(async (connection) => {
      const [users] = await connection.query<any[]>(
        `SELECT id, role, is_active FROM users WHERE id = ? AND role IN ('driver','owner') LIMIT 1 FOR UPDATE`,
        [parsed.data.driverUserId]
      );
      if (!users[0] || !users[0].is_active) return null;
      const [insert] = await connection.execute<any>(
        `INSERT INTO jobs (public_id, driver_user_id, game, cargo, origin_city, destination_city, distance_km, payout_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [publicId, parsed.data.driverUserId, parsed.data.game, parsed.data.cargo, parsed.data.originCity, parsed.data.destinationCity, parsed.data.distanceKm ?? null, parsed.data.payoutAmount]
      );
      const jobId = Number(insert.insertId);
      await event(connection, jobId, actor.id, 'job.assigned', null, 'assigned', { payoutAmount: parsed.data.payoutAmount });
      return jobId;
    });

    if (!result) return reply.code(404).send({ error: 'driver_not_found_or_inactive' });
    return reply.code(201).send({ id: publicId, status: 'assigned' });
  });

  app.get('/api/v2/jobs/mine', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const [rows] = await db.query<any[]>(
      `SELECT public_id AS id, status, game, cargo, origin_city AS originCity, destination_city AS destinationCity,
              distance_km AS distanceKm, payout_amount AS payoutAmount, submitted_at AS submittedAt,
              approved_at AS approvedAt, paid_at AS paidAt, created_at AS createdAt
         FROM jobs WHERE driver_user_id = ? ORDER BY created_at DESC LIMIT 250`,
      [user.id]
    );
    return { jobs: rows };
  });

  app.get('/api/v2/owner/jobs', { preHandler: requireStaff(['owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT j.public_id AS id, j.status, j.game, j.cargo, j.origin_city AS originCity,
              j.destination_city AS destinationCity, j.distance_km AS distanceKm, j.payout_amount AS payoutAmount,
              j.submitted_at AS submittedAt, j.approved_at AS approvedAt, j.paid_at AS paidAt,
              j.created_at AS createdAt, u.id AS driverUserId, u.username, u.display_name AS driverDisplayName, u.role AS driverRole
         FROM jobs j JOIN users u ON u.id = j.driver_user_id
        ORDER BY j.created_at DESC LIMIT 1000`
    );
    return { jobs: rows };
  });

  app.post('/api/v2/jobs/:id/start', { preHandler: requireUser }, async (request, reply) => {
    const params = publicIdParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_job_id' });
    const user = currentUser(request);

    const changed = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(`SELECT id, status FROM jobs WHERE public_id = ? AND driver_user_id = ? LIMIT 1 FOR UPDATE`, [params.data.id, user.id]);
      const job = rows[0];
      if (!job) return 'missing';
      if (job.status === 'in_progress') return 'ok';
      if (job.status !== 'assigned') return 'conflict';
      await connection.execute(`UPDATE jobs SET status = 'in_progress' WHERE id = ?`, [job.id]);
      await event(connection, job.id, user.id, 'job.started', 'assigned', 'in_progress');
      return 'ok';
    });

    if (changed === 'missing') return reply.code(404).send({ error: 'job_not_found' });
    if (changed === 'conflict') return reply.code(409).send({ error: 'invalid_job_state' });
    return { ok: true, status: 'in_progress' };
  });

  app.post('/api/v2/jobs/:id/submit', { preHandler: requireUser }, async (request, reply) => {
    const params = publicIdParams.safeParse(request.params);
    const body = submitSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_submission' });
    const user = currentUser(request);

    const result = await withTransaction(async (connection) => {
      const [dupe] = await connection.query<any[]>(`SELECT public_id, status FROM jobs WHERE driver_user_id = ? AND client_submission_id = ? LIMIT 1`, [user.id, body.data.clientSubmissionId]);
      if (dupe[0]) return { kind: 'duplicate', status: dupe[0].status } as const;
      const [rows] = await connection.query<any[]>(
        `SELECT j.id, j.status, j.driver_user_id, j.payout_amount, u.role AS driver_role
           FROM jobs j JOIN users u ON u.id = j.driver_user_id
          WHERE j.public_id = ? AND j.driver_user_id = ? LIMIT 1 FOR UPDATE`,
        [params.data.id, user.id]
      );
      const job = rows[0];
      if (!job) return { kind: 'missing' } as const;
      if (job.status !== 'in_progress') return { kind: 'conflict' } as const;

      if (job.driver_role === 'owner') {
        await connection.execute(
          `UPDATE jobs SET status = 'approved', client_submission_id = ?, distance_km = ?, revenue_game = ?, submitted_at = NOW(3), approved_at = NOW(3) WHERE id = ?`,
          [body.data.clientSubmissionId, body.data.distanceKm, body.data.revenueGame ?? null, job.id]
        );
        await event(connection, job.id, user.id, 'job.submitted', 'in_progress', 'submitted', { clientSubmissionId: body.data.clientSubmissionId });
        await event(connection, job.id, user.id, 'job.owner_auto_approved', 'submitted', 'approved');
        const payoutId = await createPayout(connection, job, user.id, 'owner_auto_approval');
        return { kind: 'owner_approved', payoutId } as const;
      }

      await connection.execute(
        `UPDATE jobs SET status = 'submitted', client_submission_id = ?, distance_km = ?, revenue_game = ?, submitted_at = NOW(3) WHERE id = ?`,
        [body.data.clientSubmissionId, body.data.distanceKm, body.data.revenueGame ?? null, job.id]
      );
      await event(connection, job.id, user.id, 'job.submitted', 'in_progress', 'submitted', { clientSubmissionId: body.data.clientSubmissionId });
      return { kind: 'submitted' } as const;
    });

    if (result.kind === 'missing') return reply.code(404).send({ error: 'job_not_found' });
    if (result.kind === 'conflict') return reply.code(409).send({ error: 'invalid_job_state' });
    if (result.kind === 'duplicate') return { ok: true, duplicate: true, status: result.status };
    if (result.kind === 'owner_approved') return { ok: true, status: 'approved', autoApproved: true, payoutId: result.payoutId };
    return { ok: true, status: 'submitted', approvalRequired: true };
  });

  app.post('/api/v2/owner/jobs/:id/approve', { preHandler: requireStaff(['owner']) }, async (request, reply) => {
    const params = publicIdParams.safeParse(request.params);
    const body = reviewSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_review' });
    const actor = currentUser(request);

    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(`SELECT id, driver_user_id, status, payout_amount FROM jobs WHERE public_id = ? LIMIT 1 FOR UPDATE`, [params.data.id]);
      const job = rows[0];
      if (!job) return { kind: 'missing' } as const;
      if (job.status === 'approved' || job.status === 'paid') {
        const [payouts] = await connection.query<any[]>(`SELECT public_id, status FROM payouts WHERE job_id = ? LIMIT 1`, [job.id]);
        return { kind: 'already', payout: payouts[0] ?? null } as const;
      }
      if (job.status !== 'submitted') return { kind: 'conflict' } as const;

      await connection.execute(`UPDATE jobs SET status = 'approved', approved_at = NOW(3) WHERE id = ?`, [job.id]);
      await event(connection, job.id, actor.id, 'job.approved', 'submitted', 'approved', { notes: body.data.notes ?? null });
      const payoutId = await createPayout(connection, job, actor.id, 'owner_approval');
      return { kind: 'approved', payoutId } as const;
    });

    if (result.kind === 'missing') return reply.code(404).send({ error: 'job_not_found' });
    if (result.kind === 'conflict') return reply.code(409).send({ error: 'job_not_submitted' });
    if (result.kind === 'already') return { ok: true, duplicate: true, payout: result.payout };
    return { ok: true, status: 'approved', payoutId: result.payoutId };
  });

  app.post('/api/v2/owner/jobs/:id/decline', { preHandler: requireStaff(['owner']) }, async (request, reply) => {
    const params = publicIdParams.safeParse(request.params);
    const body = reviewSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_review' });
    const actor = currentUser(request);

    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(`SELECT id, status FROM jobs WHERE public_id = ? LIMIT 1 FOR UPDATE`, [params.data.id]);
      const job = rows[0];
      if (!job) return 'missing';
      if (job.status === 'declined') return 'ok';
      if (job.status !== 'submitted') return 'conflict';
      await connection.execute(`UPDATE jobs SET status = 'declined' WHERE id = ?`, [job.id]);
      await event(connection, job.id, actor.id, 'job.declined', 'submitted', 'declined', { notes: body.data.notes ?? null });
      return 'ok';
    });

    if (result === 'missing') return reply.code(404).send({ error: 'job_not_found' });
    if (result === 'conflict') return reply.code(409).send({ error: 'job_not_submitted' });
    return { ok: true, status: 'declined' };
  });
}
