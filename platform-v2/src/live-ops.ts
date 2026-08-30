import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from './db.js';
import { requireStaff, requireUser } from './auth.js';

type CurrentUser = { id: number; role: string };

const heartbeatSchema = z.object({
  trackerVersion: z.string().trim().max(40).optional(),
  game: z.enum(['ets2', 'ats']).nullable().optional(),
  gameRunning: z.boolean().default(false),
  onJob: z.boolean().default(false),
  status: z.enum(['online', 'idle', 'driving', 'on_job']).default('online'),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  worldX: z.number().min(-100000000).max(100000000).nullable().optional(),
  worldY: z.number().min(-100000000).max(100000000).nullable().optional(),
  worldZ: z.number().min(-100000000).max(100000000).nullable().optional(),
  headingDeg: z.number().min(0).max(360).nullable().optional(),
  speedKph: z.number().min(0).max(400).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  truckMake: z.string().trim().max(80).nullable().optional(),
  truckModel: z.string().trim().max(120).nullable().optional(),
  cargo: z.string().trim().max(160).nullable().optional(),
  originCity: z.string().trim().max(120).nullable().optional(),
  destinationCity: z.string().trim().max(120).nullable().optional(),
  fuelPercent: z.number().min(0).max(100).nullable().optional(),
  damagePercent: z.number().min(0).max(100).nullable().optional(),
  finesTotal: z.number().min(0).max(100000000000).nullable().optional()
});

const eventSchema = z.object({
  eventType: z.enum(['game.started', 'game.stopped', 'job.started', 'job.delivered', 'job.cancelled', 'fine', 'damage.changed', 'tracker.started', 'tracker.stopped']),
  game: z.enum(['ets2', 'ats']).nullable().optional(),
  jobPublicId: z.string().uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional()
});

function currentUser(request: FastifyRequest): CurrentUser {
  return (request as any).sterlingUser as CurrentUser;
}

export async function registerLiveOpsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v2/tracker/heartbeat', { preHandler: requireUser }, async (request, reply) => {
    const body = heartbeatSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_heartbeat', details: body.error.flatten() });
    const user = currentUser(request);
    const d = body.data;

    await db.execute(
      `INSERT INTO driver_presence
        (user_id, tracker_version, game, game_running, on_job, status, last_seen_at, last_login_at,
         latitude, longitude, world_x, world_y, world_z, heading_deg, speed_kph, city, truck_make, truck_model, cargo,
         origin_city, destination_city, fuel_percent, damage_percent, fines_total)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         tracker_version = VALUES(tracker_version), game = VALUES(game), game_running = VALUES(game_running),
         on_job = VALUES(on_job), status = VALUES(status), last_seen_at = NOW(3),
         latitude = VALUES(latitude), longitude = VALUES(longitude), world_x = VALUES(world_x),
         world_y = VALUES(world_y), world_z = VALUES(world_z), heading_deg = VALUES(heading_deg),
         speed_kph = VALUES(speed_kph), city = VALUES(city), truck_make = VALUES(truck_make),
         truck_model = VALUES(truck_model), cargo = VALUES(cargo), origin_city = VALUES(origin_city),
         destination_city = VALUES(destination_city), fuel_percent = VALUES(fuel_percent),
         damage_percent = VALUES(damage_percent), fines_total = VALUES(fines_total)`,
      [user.id, d.trackerVersion ?? null, d.game ?? null, d.gameRunning ? 1 : 0, d.onJob ? 1 : 0, d.status,
       d.latitude ?? null, d.longitude ?? null, d.worldX ?? null, d.worldY ?? null, d.worldZ ?? null,
       d.headingDeg ?? null, d.speedKph ?? null, d.city ?? null, d.truckMake ?? null, d.truckModel ?? null,
       d.cargo ?? null, d.originCity ?? null, d.destinationCity ?? null, d.fuelPercent ?? null,
       d.damagePercent ?? null, d.finesTotal ?? null]
    );

    return { ok: true, serverTime: new Date().toISOString() };
  });

  app.post('/api/v2/tracker/events', { preHandler: requireUser }, async (request, reply) => {
    const body = eventSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_event' });
    const user = currentUser(request);
    let jobId: number | null = null;

    if (body.data.jobPublicId) {
      const [jobs] = await db.query<any[]>(
        `SELECT id FROM jobs WHERE public_id = ? AND driver_user_id = ? LIMIT 1`,
        [body.data.jobPublicId, user.id]
      );
      jobId = jobs[0]?.id ?? null;
    }

    await db.execute(
      `INSERT INTO telemetry_events (user_id, job_id, event_type, game, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, jobId, body.data.eventType, body.data.game ?? null, body.data.payload ? JSON.stringify(body.data.payload) : null]
    );
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/v2/owner/live/drivers', { preHandler: requireStaff(['owner']) }, async () => {
    const [rows] = await db.query<any[]>(
      `SELECT u.id, u.username, u.display_name AS displayName, u.role, u.rank_name AS rankName,
              p.tracker_version AS trackerVersion, p.game, p.game_running AS gameRunning,
              p.on_job AS onJob, p.status, p.last_seen_at AS lastSeenAt,
              TIMESTAMPDIFF(SECOND, p.last_seen_at, NOW(3)) <= 45 AS isOnline,
              p.latitude, p.longitude, p.world_x AS worldX, p.world_y AS worldY, p.world_z AS worldZ,
              p.heading_deg AS headingDeg, p.speed_kph AS speedKph,
              p.city, p.truck_make AS truckMake, p.truck_model AS truckModel, p.cargo,
              p.origin_city AS originCity, p.destination_city AS destinationCity,
              p.fuel_percent AS fuelPercent, p.damage_percent AS damagePercent, p.fines_total AS finesTotal
         FROM users u
         LEFT JOIN driver_presence p ON p.user_id = u.id
        WHERE u.role IN ('driver','owner') AND u.is_active = 1
        ORDER BY isOnline DESC, u.display_name`
    );

    return {
      drivers: rows.map((r) => ({
        ...r,
        gameRunning: Boolean(r.gameRunning),
        onJob: Boolean(r.onJob),
        isOnline: Boolean(r.isOnline)
      }))
    };
  });

  app.get('/api/v2/owner/live/summary', { preHandler: requireStaff(['owner']) }, async () => {
    const [[presence]] = await db.query<any[]>(
      `SELECT COUNT(*) AS activeDrivers,
              SUM(CASE WHEN p.last_seen_at >= NOW(3) - INTERVAL 45 SECOND THEN 1 ELSE 0 END) AS onlineDrivers,
              SUM(CASE WHEN p.last_seen_at >= NOW(3) - INTERVAL 45 SECOND AND p.on_job = 1 THEN 1 ELSE 0 END) AS onJob
         FROM users u LEFT JOIN driver_presence p ON p.user_id = u.id
        WHERE u.role IN ('driver','owner') AND u.is_active = 1`
    );
    const [[jobs]] = await db.query<any[]>(
      `SELECT SUM(status = 'in_progress') AS jobsInProgress,
              SUM(status = 'submitted') AS pendingApprovals
         FROM jobs`
    );
    const [[payouts]] = await db.query<any[]>(
      `SELECT SUM(status IN ('pending','processing','retrying')) AS pendingPayouts,
              SUM(status = 'failed') AS failedPayouts
         FROM payouts`
    );
    return { ...presence, ...jobs, ...payouts };
  });
}
