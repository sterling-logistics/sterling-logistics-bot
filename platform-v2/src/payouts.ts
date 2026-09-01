import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction } from './db.js';
import { requireUser } from './auth.js';

type CurrentUser = { id: number };

const completeSchema = z.object({
  leaseToken: z.string().uuid(),
  applicationId: z.string().uuid(),
  balanceBefore: z.coerce.number().min(0).max(100000000000),
  balanceAfter: z.coerce.number().min(0).max(100000000000)
});

const failSchema = z.object({
  leaseToken: z.string().uuid(),
  error: z.string().trim().min(1).max(1000)
});

const payoutIdParams = z.object({ id: z.string().uuid() });
const maxPayoutAttempts = 5;

function currentUser(request: FastifyRequest): CurrentUser {
  return (request as any).sterlingUser as CurrentUser;
}

export async function registerPayoutRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v2/payouts/claim-next', { preHandler: requireUser }, async (request, reply) => {
    const user = currentUser(request);
    const leaseToken = randomUUID();
    const leaseSeconds = 120;

    const payout = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(
        `SELECT p.id, p.public_id, p.amount, p.currency, p.status, p.attempt_count, p.lease_expires_at,
                j.public_id AS job_public_id, j.game
           FROM payouts p
           JOIN jobs j ON j.id = p.job_id
          WHERE p.driver_user_id = ?
            AND p.attempt_count < ?
            AND (
              p.status IN ('pending','retrying')
              OR (p.status = 'processing' AND p.lease_expires_at IS NOT NULL AND p.lease_expires_at <= NOW(3))
            )
          ORDER BY p.created_at ASC
          LIMIT 1 FOR UPDATE`,
        [user.id, maxPayoutAttempts]
      );
      const row = rows[0];
      if (!row) return null;

      await connection.execute(
        `UPDATE payouts
            SET status = 'processing', lease_token = ?, lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND),
                attempt_count = attempt_count + 1, last_error = NULL
          WHERE id = ?`,
        [leaseToken, leaseSeconds, row.id]
      );
      await connection.execute(
        `INSERT INTO payout_events (payout_id, event_type, payload)
         VALUES (?, 'payout.claimed', JSON_OBJECT('leaseSeconds', ?, 'attempt', ?))`,
        [row.id, leaseSeconds, Number(row.attempt_count) + 1]
      );

      return {
        id: row.public_id,
        jobId: row.job_public_id,
        game: row.game,
        amount: row.amount,
        currency: row.currency,
        leaseToken,
        leaseSeconds
      };
    });

    if (!payout) return reply.code(204).send();
    return payout;
  });

  app.post('/api/v2/payouts/:id/complete', { preHandler: requireUser }, async (request, reply) => {
    const params = payoutIdParams.safeParse(request.params);
    const body = completeSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_payout_confirmation' });
    const user = currentUser(request);

    if (body.data.balanceAfter < body.data.balanceBefore) {
      return reply.code(400).send({ error: 'invalid_balance_confirmation' });
    }

    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(
        `SELECT p.id, p.job_id, p.amount, p.status, p.lease_token, p.lease_expires_at, p.application_id
           FROM payouts p
          WHERE p.public_id = ? AND p.driver_user_id = ?
          LIMIT 1 FOR UPDATE`,
        [params.data.id, user.id]
      );
      const payout = rows[0];
      if (!payout) return { kind: 'missing' } as const;

      if (payout.status === 'applied') {
        if (payout.application_id === body.data.applicationId) return { kind: 'already' } as const;
        return { kind: 'conflict' } as const;
      }

      if (payout.status !== 'processing' || payout.lease_token !== body.data.leaseToken) {
        return { kind: 'lease_invalid' } as const;
      }
      if (!payout.lease_expires_at || new Date(payout.lease_expires_at).getTime() < Date.now()) {
        return { kind: 'lease_expired' } as const;
      }

      const expectedAfter = Number(body.data.balanceBefore) + Number(payout.amount);
      if (Math.abs(Number(body.data.balanceAfter) - expectedAfter) > 0.01) {
        return { kind: 'amount_mismatch', expectedAfter } as const;
      }

      try {
        await connection.execute(
          `UPDATE payouts
              SET status = 'applied', application_id = ?, confirmed_balance_before = ?, confirmed_balance_after = ?,
                  applied_at = NOW(3), lease_token = NULL, lease_expires_at = NULL, last_error = NULL
            WHERE id = ?`,
          [body.data.applicationId, body.data.balanceBefore, body.data.balanceAfter, payout.id]
        );
      } catch (error: any) {
        if (error?.code === 'ER_DUP_ENTRY') return { kind: 'application_duplicate' } as const;
        throw error;
      }

      await connection.execute(`UPDATE jobs SET status = 'paid', paid_at = NOW(3) WHERE id = ? AND status = 'approved'`, [payout.job_id]);
      await connection.execute(
        `INSERT INTO payout_events (payout_id, event_type, payload)
         VALUES (?, 'payout.applied', JSON_OBJECT('applicationId', ?, 'balanceBefore', ?, 'balanceAfter', ?))`,
        [payout.id, body.data.applicationId, body.data.balanceBefore, body.data.balanceAfter]
      );
      return { kind: 'applied' } as const;
    });

    if (result.kind === 'missing') return reply.code(404).send({ error: 'payout_not_found' });
    if (result.kind === 'already') return { ok: true, duplicate: true, status: 'applied' };
    if (result.kind === 'conflict' || result.kind === 'application_duplicate') return reply.code(409).send({ error: 'payout_confirmation_conflict' });
    if (result.kind === 'lease_invalid' || result.kind === 'lease_expired') return reply.code(409).send({ error: result.kind });
    if (result.kind === 'amount_mismatch') return reply.code(409).send({ error: 'payout_amount_mismatch', expectedAfter: result.expectedAfter });
    return { ok: true, status: 'applied' };
  });

  app.post('/api/v2/payouts/:id/fail', { preHandler: requireUser }, async (request, reply) => {
    const params = payoutIdParams.safeParse(request.params);
    const body = failSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_payout_failure' });
    const user = currentUser(request);

    const result = await withTransaction(async (connection) => {
      const [rows] = await connection.query<any[]>(
        `SELECT id, status, lease_token, attempt_count FROM payouts WHERE public_id = ? AND driver_user_id = ? LIMIT 1 FOR UPDATE`,
        [params.data.id, user.id]
      );
      const payout = rows[0];
      if (!payout) return 'missing';
      if (payout.status === 'applied') return 'applied';
      if (payout.status !== 'processing' || payout.lease_token !== body.data.leaseToken) return 'lease_invalid';

      const terminal = Number(payout.attempt_count) >= maxPayoutAttempts;
      const nextStatus = terminal ? 'failed' : 'retrying';
      await connection.execute(
        `UPDATE payouts
            SET status = ?, lease_token = NULL, lease_expires_at = NULL, last_error = ?
          WHERE id = ?`,
        [nextStatus, body.data.error, payout.id]
      );
      await connection.execute(
        `INSERT INTO payout_events (payout_id, event_type, payload)
         VALUES (?, ?, JSON_OBJECT('error', ?, 'attempt', ?))`,
        [payout.id, terminal ? 'payout.failed' : 'payout.retry_scheduled', body.data.error, payout.attempt_count]
      );
      return nextStatus;
    });

    if (result === 'missing') return reply.code(404).send({ error: 'payout_not_found' });
    if (result === 'applied') return { ok: true, status: 'applied' };
    if (result === 'lease_invalid') return reply.code(409).send({ error: 'lease_invalid' });
    return { ok: true, status: result };
  });
}
