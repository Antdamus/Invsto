import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
});

serve(async (req) => {
  const sig = req.headers.get("stripe-signature")!;
  const body = await req.text();

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!
    );
  } catch (err) {
    return new Response("Invalid signature", { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("Ignored", { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const reservationId = session.metadata?.reservation_id;

  if (!reservationId) {
    return new Response("No reservation", { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 🔒 Idempotency check
  const existing = await fetch(
    `${supabaseUrl}/rest/v1/storefront_stripe_events?stripe_event_id=eq.${event.id}`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    }
  );

  const existingData = await existing.json();
  if (existingData.length > 0) {
    return new Response("Already processed", { status: 200 });
  }

  // Insert event record
  await fetch(`${supabaseUrl}/rest/v1/storefront_stripe_events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      stripe_event_id: event.id,
      event_type: event.type,
      reservation_id: reservationId,
      raw: event,
    }),
  });

  // Fetch reservation items
  const resItems = await fetch(
    `${supabaseUrl}/rest/v1/storefront_reservation_items?reservation_id=eq.${reservationId}`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    }
  );

  const items = await resItems.json();

  // Create sales record
  const saleRes = await fetch(`${supabaseUrl}/rest/v1/sales`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      external_sales_id: session.id,
      email: session.customer_details?.email ?? null,
      platform: "stripe",
      subtotal: session.amount_subtotal! / 100,
      final_amount: session.amount_total! / 100,
      profit_amount: session.amount_total! / 100,
    }),
  });

  const sale = await saleRes.json();
  const saleId = sale[0].id;

  // Create sale_items + decrement stock
  for (const item of items) {

    await fetch(`${supabaseUrl}/rest/v1/sale_items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        sale_id: saleId,
        item_id: item.item_type_id,
        title: "Purchased Item",
        quantity: item.qty,
        sale_price: 0,
        final_price: 0,
      }),
    });

    await fetch(`${supabaseUrl}/rest/v1/stock_transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        item_id: item.item_type_id,
        location_id: null,
        quantity: -item.qty,
        action_type: "checkout",
        method: "stripe",
        source_transaction_id: null,
      }),
    });
  }

  // Mark reservation paid
  await fetch(`${supabaseUrl}/rest/v1/storefront_reservations?id=eq.${reservationId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      status: "paid",
      stripe_payment_intent_id: session.payment_intent,
    }),
  });

  return new Response("Success", { status: 200 });
});
