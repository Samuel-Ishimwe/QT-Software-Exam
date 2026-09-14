import { Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import { pool } from '../db/pool';
import { ConfigService } from './config.service';

/**
 * Lets the land authority change subdivision/QA tolerances without a release.
 * Out of scope: auth on this endpoint (see "explicitly out of scope" in the brief) --
 * in production this would sit behind the same admin auth as the rest of the
 * back office, not open on the public network.
 */
@Controller('admin/config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  async getAll() {
    const { rows } = await pool.query(
      'SELECT key, value, unit, description, updated_at FROM system_config ORDER BY key',
    );
    return rows;
  }

  @Patch(':key')
  async update(@Param('key') key: string, @Body('value') value: number) {
    const { rows } = await pool.query(
      'UPDATE system_config SET value = $1, updated_at = now() WHERE key = $2 RETURNING key, value, unit, description, updated_at',
      [value, key],
    );
    if (!rows.length) throw new NotFoundException(`no config key ${key}`);
    return rows[0];
  }
}
