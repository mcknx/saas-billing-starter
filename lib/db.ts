import pg from "pg";
import type { Db } from "./stripe-webhook";

// Server-only connection with the service role (bypasses RLS), e.g. Supabase's direct Postgres URL.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const db: Db = {
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const out = await fn((sql, params) => client.query(sql, params));
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  },
};
