import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
  // These two are the usual fix for Supabase Edge (Deno)
  httpClient: Stripe.createFetchHttpClient(),
  cryptoProvider: Stripe.createSubtleCryptoProvider(),
});

serve(async (req) => {
  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig) return new Response("Missing stripe-signature", { status: 400 });

    // IMPORTANT: use raw text body for signature verification
    const body = await req.text();

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        body,
        sig,
        Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      );
    } catch (_err) {
      return new Response("Invalid signature", { status: 400 });
    }

    // Always ACK quickly for non-target events
    if (event.type !== "checkout.session.completed") {
      return new Response("Ignored", { status: 200 });
    }

    const session = event.data.object as Stripe.Checkout.Session;
    const reservationId = session.metadata?.reservation_id;
    if (!reservationId) return new Response("No reservation_id metadata", { status: 400 });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1) Idempotency: record stripe_event_id first (unique)
    const insertEvt = await fetch(`${supabaseUrl}/rest/v1/storefront_stripe_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        stripe_event_id: event.id,
        event_type: event.type,
        reservation_id: reservationId,
        raw: event,
      }),
    });

    // If duplicate (already processed), Stripe should get 200
    if (!insertEvt.ok) {
      const t = await insertEvt.text();
      if (t.includes("duplicate") || t.includes("23505")) {
        return new Response("Already processed", { status: 200 });
      }
      return new Response(`Event insert failed: ${t}`, { status: 400 });
    }

    // 2) Mark reservation paid + store stripe ids (your “single authority” step)
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/storefront_reservations?id=eq.${reservationId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          status: "paid",
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: session.payment_intent,
        }),
      },
    );

    if (!patchRes.ok) {
      const t = await patchRes.text();
      return new Response(`Reservation patch failed: ${t}`, { status: 400 });
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    return new Response(`Webhook error: ${err?.message ?? err}`, { status: 500 });
  }
});
