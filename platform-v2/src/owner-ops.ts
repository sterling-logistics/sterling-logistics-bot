import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, pingDatabase } from './db.js';
import { requireStaff } from './auth.js';

const driverParams = z.object({ id: z.coerce.number().int().positive() });

export async function registerOwnerOperationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/owner/jobs/pending-review', { preHandler: requireStaff(['owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT j.public_id AS id, j.game, j.cargo, j.origin_city AS originCity,
              j.destination_city AS destinationCity, j.distance_km AS distanceKm,
              j.payout_amount AS payoutAmount, j.revenue_game AS revenueGame,
              j.submitted_at AS submittedAt, u.id AS driverUserId,
              u.username, u.display_name AS driverDisplayName, u.rank_name AS rankName
         FROM jobs j
         JOIN users u ON u.id = j.driver_user_id
        WHERE j.status = 'submitted'
        ORDER BY j.submitted_at ASC, j.id ASC
        LIMIT 500`
    );
    return { jobs: rows };
  });

  app.get('/api/v2/owner/payouts', { preHandler: requireStaff(['owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT p.public_id AS id, j.public_id AS jobId, p.amount, p.currency, p.status,
              p.attempt_count AS attemptCount, p.lease_expires_at AS leaseExpiresAt,
              p.confirmed_balance_before AS balanceBefore, p.confirmed_balance_after AS balanceAfter,
              p.last_error AS lastError, p.applied_at AS appliedAt, p.created_at AS createdAt,
              u.id AS driverUserId, u.username, u.display_name AS driverDisplayName
         FROM payouts p
         JOIN jobs j ON j.id = p.job_id
         JOIN users u ON u.id = p.driver_user_id
        ORDER BY p.created_at DESC
        LIMIT 1000`
    );
    return { payouts: rows };
  });

  app.get('/api/v2/owner/audit', { preHandler: requireStaff(['owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT a.id, a.event_type AS eventType, a.entity_type AS entityType,
              a.entity_id AS entityId, a.metadata, a.created_at AS createdAt,
              actor.username AS actorUsername, actor.display_name AS actorDisplayName,
              target.username AS targetUsername, target.display_name AS targetDisplayName
         FROM audit_events a
         LEFT JOIN users actor ON actor.id = a.actor_user_id
         LEFT JOIN users target ON target.id = a.target_user_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 2000`
    );
    return { events: rows };
  });

  app.get('/api/v2/owner/drivers/:id/history', { preHandler: requireStaff(['owner']) }, async (request, reply) => {
    const params = driverParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_driver_id' });

    const [users] = await db.query<any[]>(
      `SELECT id, username, display_name AS displayName, role, rank_name AS rankName, is_active AS isActive,
              created_at AS createdAt
         FROM users WHERE id = ? AND role IN ('driver','owner') LIMIT 1`,
      [params.data.id]
    );
    if (!users[0]) return reply.code(404).send({ error: 'driver_not_found' });

    const [jobs] = await db.query<any[]>(
      `SELECT public_id AS id, status, game, cargo, origin_city AS originCity,
              destination_city AS destinationCity, distance_km AS distanceKm,
              payout_amount AS payoutAmount, revenue_game AS revenueGame,
              submitted_at AS submittedAt, approved_at AS approvedAt, paid_at AS paidAt,
              created_at AS createdAt
         FROM jobs WHERE driver_user_id = ?
        ORDER BY created_at DESC LIMIT 1000`,
      [params.data.id]
    );

    const [[stats]] = await db.query<any[]>(
      `SELECT COUNT(*) AS totalJobs,
              SUM(status IN ('approved','paid')) AS completedJobs,
              COALESCE(SUM(CASE WHEN status IN ('approved','paid') THEN distance_km ELSE 0 END),0) AS totalDistanceKm,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN payout_amount ELSE 0 END),0) AS totalPaid
         FROM jobs WHERE driver_user_id = ?`,
      [params.data.id]
    );

    return { driver: { ...users[0], isActive: Boolean(users[0].isActive) }, stats, jobs };
  });

  app.get('/api/v2/owner/system', { preHandler: requireStaff(['owner']) }, async () => {
    const database = await pingDatabase().catch(() => false);
    const [[counts]] = await db.query<any[]>(
      `SELECT
        (SELECT COUNT(*) FROM users WHERE is_active = 1) AS activeAccounts,
        (SELECT COUNT(*) FROM jobs) AS totalJobs,
        (SELECT COUNT(*) FROM payouts) AS totalPayouts,
        (SELECT COUNT(*) FROM payouts WHERE status = 'failed') AS failedPayouts`
    );
    return {
      api: 'online',
      database: database ? 'online' : 'offline',
      version: '2.0.0-alpha.4',
      serverTime: new Date().toISOString(),
      ...counts
    };
  });
}
