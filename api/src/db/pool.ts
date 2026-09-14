import { Pool } from 'pg';

export const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 55432),
  database: process.env.PGDATABASE ?? 'cadastre',
  user: process.env.PGUSER ?? 'cadastre',
  password: process.env.PGPASSWORD ?? 'cadastre',
  max: Number(process.env.PGPOOL_MAX ?? 20),
});
