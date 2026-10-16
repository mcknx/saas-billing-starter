import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, as, ids } from "./helpers.ts";

let pg: PGlite;
let acme: string;
let globex: string;

before(async () => {
  ({ pg } = await freshDb());
  acme = await as(pg, ids.alice, async () => (await pg.query<{ id: string }>("select create_org('Acme') as id")).rows[0].id);
  globex = await as(pg, ids.carol, async () => (await pg.query<{ id: string }>("select create_org('Globex') as id")).rows[0].id);
  await pg.query("insert into members (org_id, user_id, role) values ($1, $2, 'member')", [acme, ids.bob]);
  await pg.query("insert into subscriptions values ($1, 'sub_acme', 'active', 'price_pro', now() + interval '30 days', now())", [acme]);
  await pg.query("insert into projects (org_id, name) values ($1, 'Acme roadmap'), ($2, 'Globex secret')", [acme, globex]);
});

const count = async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows.length;

test("tenants are isolated: Carol (Globex) sees nothing of Acme", async () => {
  await as(pg, ids.carol, async () => {
    assert.deepEqual((await pg.query<{ name: string }>("select name from projects")).rows.map((r) => r.name), ["Globex secret"]);
    assert.equal(await count("select 1 from orgs where id = $1", [acme]), 0);
    assert.equal(await count("select 1 from members where org_id = $1", [acme]), 0);
    assert.equal(await count("select 1 from subscriptions where org_id = $1", [acme]), 0);
  });
});

test("a plain member can read the org but cannot invite people or change roles", async () => {
  await as(pg, ids.bob, async () => {
    assert.equal(await count("select 1 from projects"), 1);
    await assert.rejects(pg.query("insert into members values ($1, $2, 'member')", [acme, ids.dave]), /row-level security/);
    const upd = await pg.query("update members set role = 'admin' where user_id = $1", [ids.bob]);
    assert.equal(upd.affectedRows, 0, "self-promotion silently matches no rows");
  });
});

test("owner invites an admin; an admin can invite but cannot create a second owner or change roles", async () => {
  await as(pg, ids.alice, () => pg.query("insert into members values ($1, $2, 'admin')", [acme, ids.dave]));
  await as(pg, ids.dave, async () => {
    await assert.rejects(pg.query("insert into members values ($1, $2, 'owner')", [acme, ids.carol]), /row-level security/);
    assert.equal((await pg.query("update members set role = 'member' where user_id = $1", [ids.bob])).affectedRows, 0);
    assert.equal((await pg.query("delete from members where user_id = $1", [ids.alice])).affectedRows, 0, "the owner row cannot be removed");
  });
});

test("billing gate: projects can only be created while the subscription is active", async () => {
  await as(pg, ids.alice, () => pg.query("insert into projects (org_id, name) values ($1, 'Q3 plan')", [acme]));
  await pg.query("update subscriptions set status = 'canceled' where org_id = $1", [acme]);
  await as(pg, ids.alice, async () => {
    await assert.rejects(pg.query("insert into projects (org_id, name) values ($1, 'Q4 plan')", [acme]), /row-level security/);
    assert.equal(await count("select 1 from projects"), 2, "existing data stays readable after cancelling");
  });
});

test("signed-in users cannot touch billing tables directly", async () => {
  await as(pg, ids.alice, async () => {
    await assert.rejects(pg.query("update subscriptions set status = 'active'"), /permission denied/);
    await assert.rejects(pg.query("select * from stripe_events"), /permission denied/);
  });
});
