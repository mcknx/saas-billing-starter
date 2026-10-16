import Stripe from "stripe";
import { db } from "@/lib/db";
import { handleStripeWebhook } from "@/lib/stripe-webhook";

export async function POST(req: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!); // created per request so `next build` needs no secrets
  // Raw text, not JSON: the signature is computed over the exact bytes Stripe sent.
  const r = await handleStripeWebhook(await req.text(), req.headers.get("stripe-signature"), {
    stripe,
    secret: process.env.STRIPE_WEBHOOK_SECRET!,
    db,
  });
  return new Response(r.body, { status: r.status });
}
