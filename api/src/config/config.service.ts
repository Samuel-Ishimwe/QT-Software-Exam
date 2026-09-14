import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';

/**
 * Tolerances live in the system_config table, not in code or env vars, so the
 * land authority can change them (e.g. min plot size) without a release.
 * No caching: a request always sees the latest admin-set value.
 */
@Injectable()
export class ConfigService {
  async getAll(): Promise<Record<string, number>> {
    const { rows } = await pool.query('SELECT key, value FROM system_config');
    const out: Record<string, number> = {};
    for (const row of rows) out[row.key] = Number(row.value);
    return out;
  }

  async get(key: string, fallback: number): Promise<number> {
    const { rows } = await pool.query('SELECT value FROM system_config WHERE key = $1', [key]);
    return rows.length ? Number(rows[0].value) : fallback;
  }
}
