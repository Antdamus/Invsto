import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@12.0.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2022-11-15",
});

serve(async (req) => {
  try {
    const { cartItems, userId, anonSessionId } = await req.json();

    if (!cartItems || cartItems.length === 0) {
      return new Response(JSON.stringify({ error: "Empty cart" }), { status: 400 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // 1️⃣ Create reservation in DB
    const reservationRes = await fetch(`${supabaseUrl}/rest/v1/rpc/create_reservation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        p_items: cartItems,
        p_user_id: userId ?? null,
        p_anon_session_id: anonSessionId ?? null,
      }),
    });

    if (!reservationRes.ok) {
      const err = await reservationRes.text();
      return new Response(JSON.stringify({ error: err }), { status: 400 });
    }

    const reservationId = await reservationRes.json();

    // 2️⃣ Create Stripe Checkout Session
    const lineItems = cartItems.map((item: any) => ({
      price_data: {
        currency: "usd",
        product_data: {
          name: item.title ?? "Item",
        },
        unit_amount: Math.round(item.price_locked * 100),
      },
      quantity: item.qty,
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${Deno.env.get("SITE_URL")}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${Deno.env.get("SITE_URL")}/cart`,
      metadata: {
        reservation_id: reservationId,
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
