import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import type { PGlite } from "@electric-sql/pglite";
import { handleStripeWebhook, checkoutParams, type Db } from "../lib/stripe-webhook.ts";
import { freshDb, as, ids } from "./helpers.ts";

const stripe = new Stripe("sk_test_dummy"); // never called over the network: only webhooks.* helpers
const secret = "whsec_test_secret";
let pg: PGlite;
let db: Db;
let org: string;

before(async () => {
  ({ pg, db } = await freshDb()); // one in-memory Postgres per file; booting it is the slow part
  org = await as(pg, ids.alice, async () => (await pg.query<{ id: string }>("select create_org('Acme') as id")).rows[0].id);
});
beforeEach(() => pg.exec("truncate stripe_events, subscriptions; update orgs set stripe_customer_id = null"));

/** Build a Stripe event and sign it exactly like Stripe does (test mode). */
function signed(id: string, type: string, object: object, created = 1_760_000_000) {
  const payload = JSON.stringify({ id, object: "event", type, created, data: { object } });
  return { payload, sig: stripe.webhooks.generateTestHeaderString({ payload, secret }) };
}
const send = (e: { payload: string; sig: string }) => handleStripeWebhook(e.payload, e.sig, { stripe, secret, db });

const subscription = (status: string, orgId = org) => ({
  id: "sub_123",
  object: "subscription",
  customer: "cus_123",
  status,
  metadata: { org_id: orgId },
  items: { data: [{ price: { id: "price_pro" }, current_period_end: 1_762_600_000 }] },
});
const row = async () => (await pg.query<{ status: string }>("select status from subscriptions where org_id = $1", [org])).rows[0];
const seen = async () => (await pg.query("select id from stripe_events")).rows.length;

test("rejects a bad signature and writes nothing", async () => {
  const e = signed("evt_1", "customer.subscription.updated", subscription("active"));
  const r = await handleStripeWebhook(e.payload, e.sig.replace(/v1=./, "v1=0"), { stripe, secret, db });
  assert.equal(r.status, 400);
  assert.equal(await seen(), 0);
  assert.equal((await handleStripeWebhook(e.payload, null, { stripe, secret, db })).status, 400);
});

test("checkout.session.completed links the Stripe customer to the org", async () => {
  const r = await send(signed("evt_1", "checkout.session.completed", { object: "checkout.session", mode: "subscription", client_reference_id: org, customer: "cus_123" }));
  assert.equal(r.status, 200);
  assert.equal((await pg.query<{ c: string }>("select stripe_customer_id c from orgs")).rows[0].c, "cus_123");
});

test("subscription events upsert the org's subscription, even before checkout completes", async () => {
  assert.equal((await send(signed("evt_1", "customer.subscription.created", subscription("trialing")))).status, 200);
  assert.equal((await row()).status, "trialing");
  await send(signed("evt_2", "customer.subscription.updated", subscription("active"), 1_760_000_100));
  assert.equal((await row()).status, "active");
});

test("idempotent: the same event delivered twice is applied once", async () => {
  const e = signed("evt_1", "customer.subscription.updated", subscription("active"));
  assert.deepEqual(await send(e), { status: 200, body: "ok" });
  await pg.query("update subscriptions set status = 'past_due'"); // a later change we must not overwrite
  assert.deepEqual(await send(e), { status: 200, body: "duplicate" });
  assert.equal((await row()).status, "past_due");
  assert.equal(await seen(), 1);
});

test("out of order: an older event cannot overwrite a newer one", async () => {
  await send(signed("evt_new", "customer.subscription.deleted", subscription("canceled"), 1_760_000_200));
  await send(signed("evt_old", "customer.subscription.updated", subscription("active"), 1_760_000_100));
  assert.equal((await row()).status, "canceled");
});

test("a failure rolls back the event record so Stripe's retry is processed", async (t) => {
  t.mock.method(console, "error", () => {}); // the handler logs the failure; keep test output clean
  const unknownOrg = "00000000-0000-0000-0000-0000000000ff";
  const bad = signed("evt_1", "customer.subscription.updated", { ...subscription("active", unknownOrg), customer: "cus_unknown" });
  assert.equal((await send(bad)).status, 500);
  assert.equal(await seen(), 0, "not marked as seen");
});

test("checkout params carry the org id to both the session and the subscription", () => {
  const p = checkoutParams(org, "price_pro", "https://app.example.test");
  assert.equal(p.client_reference_id, org);
  assert.equal(p.subscription_data?.metadata?.org_id, org);
});
