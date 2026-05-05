import { pool } from '../db/index.js';

export interface AuditEntry {
  jobId?: string | null;
  actor?: string | null;
  eventType: string;
  message?: string;
  details?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (job_id, actor, event_type, message, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      entry.jobId ?? null,
      entry.actor ?? null,
      entry.eventType,
      entry.message ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}

export async function listAudit(jobId?: string, limit = 200): Promise<unknown[]> {
  if (jobId) {
    const r = await pool.query(
      `SELECT id, job_id, actor, event_type, message, details, created_at
       FROM audit_log WHERE job_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [jobId, limit],
    );
    return r.rows;
  }
  const r = await pool.query(
    `SELECT id, job_id, actor, event_type, message, details, created_at
     FROM audit_log ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}
