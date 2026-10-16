import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../lib/stripe-webhook.ts";

export const ids = {
  alice: "00000000-0000-0000-0000-00000000000a", // owner of Acme
  bob: "00000000-0000-0000-0000-00000000000b", // member of Acme
  carol: "00000000-0000-0000-0000-00000000000c", // owner of Globex
  dave: "00000000-0000-0000-0000-00000000000d", // not in any org yet
};

/** Fresh in-memory Postgres (PGlite) with the Supabase stub + schema loaded and four users. */
export async function freshDb() {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync("db/supabase-stub.sql", "utf8"));
  await pg.exec(fs.readFileSync("db/schema.sql", "utf8"));
  for (const [name, id] of Object.entries(ids)) await pg.query("insert into auth.users values ($1, $2)", [id, `${name}@example.test`]);
  const db: Db = { tx: (fn) => pg.transaction((tx) => fn((sql, params) => tx.query(sql, params))) };
  return { pg, db };
}

/** Run queries as a signed-in user: the `authenticated` role with auth.uid() set, so RLS applies. */
export async function as<T>(pg: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await pg.exec("set role authenticated");
  try {
    return await fn();
  } finally {
    await pg.exec("reset role");
    await pg.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}
