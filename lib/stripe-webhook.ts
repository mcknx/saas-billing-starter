import type Stripe from "stripe";

/** Run fn inside one transaction; `q` runs a parameterised query. Works with pg (lib/db.ts) or PGlite (tests). */
export type Db = { tx<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> };

export type WebhookResult = { status: number; body: string };

/**
 * Verify, de-duplicate and apply one Stripe webhook.
 * - Bad signature -> 400, nothing written.
 * - Event id already seen -> 200 "duplicate", nothing applied twice.
 * - Recording the event and applying it share one transaction: if applying fails, the event is
 *   not marked as seen and the 500 makes Stripe retry it.
 */
export async function handleStripeWebhook(
  rawBody: string,
  signature: string | null,
  deps: { stripe: Stripe; secret: string; db: Db },
): Promise<WebhookResult> {
  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signature ?? "", deps.secret);
  } catch {
    return { status: 400, body: "invalid signature" };
  }

  try {
    return await deps.db.tx(async (q) => {
      const fresh = await q("insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing returning id", [event.id, event.type]);
      if (fresh.rows.length === 0) return { status: 200, body: "duplicate" };
      await apply(event, q);
      return { status: 200, body: "ok" };
    });
  } catch (e) {
    console.error("stripe webhook failed", event.id, e);
    return { status: 500, body: "error" };
  }
}

async function apply(event: Stripe.Event, q: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      if (s.mode !== "subscription" || !s.client_reference_id) return;
      await q("update orgs set stripe_customer_id = $2 where id = $1", [s.client_reference_id, s.customer]);
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      // metadata.org_id is set at checkout, so this works even if the subscription event
      // arrives before checkout.session.completed (Stripe does not guarantee order).
      const org = await q("select id from orgs where id::text = $1 or stripe_customer_id = $2 limit 1", [sub.metadata?.org_id ?? "", customer]);
      if (!org.rows[0]) throw new Error(`no org for subscription ${sub.id}`);
      const item = sub.items.data[0];
      await q(
        `insert into subscriptions (org_id, stripe_subscription_id, status, price_id, current_period_end, stripe_event_created)
         values ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6))
         on conflict (org_id) do update set
           stripe_subscription_id = excluded.stripe_subscription_id, status = excluded.status, price_id = excluded.price_id,
           current_period_end = excluded.current_period_end, stripe_event_created = excluded.stripe_event_created
         where subscriptions.stripe_event_created <= excluded.stripe_event_created`, // stale events lose
        [org.rows[0].id, sub.id, sub.status, item.price.id, item.current_period_end, event.created],
      );
      return;
    }
    default:
      return; // recorded as seen, nothing to do
  }
}

/** Params for stripe.checkout.sessions.create: ties the Stripe customer and subscription back to the org. */
export function checkoutParams(orgId: string, priceId: string, baseUrl: string): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: orgId,
    subscription_data: { metadata: { org_id: orgId } },
    success_url: `${baseUrl}/billing?ok=1`,
    cancel_url: `${baseUrl}/billing`,
  };
}
