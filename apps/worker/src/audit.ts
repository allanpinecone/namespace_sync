import { pool } from './db.js';

export async function recordAudit(entry: {
  jobId?: string | null;
  actor?: string | null;
  eventType: string;
  message?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (job_id, actor, event_type, message, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      entry.jobId ?? null,
      entry.actor ?? 'worker',
      entry.eventType,
      entry.message ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}
