import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  CUSTOMER_SMS_AUTO_MESSAGE_DEFINITIONS,
  type CustomerSmsAutoMessageKey,
  customerSmsAutoMessageDefault,
  isCustomerSmsAutoMessageKey,
} from "../_shared/customer-sms-auto-messages.ts";

const DEFAULT_FROM_PHONE = "+18664127049";
const SEND_CONFIRMATION = "SEND_OG_SMS";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

type JsonRecord = Record<string, unknown>;
type ServiceClient = any;
type Operator = {
  userId: string | null;
  email: string | null;
  actorType: "admin" | "service_role";
};
type Subscriber = {
  id: string;
  phone_e164: string;
};
type AutoMessageRow = {
  message_key: string;
  title: string;
  description: string | null;
  body: string;
  fallback_body: string;
  is_active: boolean;
  updated_by_email: string | null;
  updated_at: string | null;
};

class AdminError extends Error {
  status: number;
  code: string;
  details: JsonRecord;

  constructor(code: string, options: { status?: number; message?: string; details?: JsonRecord } = {}) {
    super(options.message || code);
    this.name = "AdminError";
    this.code = code;
    this.status = options.status || 500;
    this.details = options.details || {};
  }
}

class TwilioSendError extends Error {
  status: number;
  twilioCode: string;
  payload: unknown;

  constructor(status: number, twilioCode: string, message: string, payload: unknown) {
    super(message);
    this.name = "TwilioSendError";
    this.status = status;
    this.twilioCode = twilioCode;
    this.payload = payload;
  }
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new AdminError("configuration_error", { status: 500, message: `Missing ${name}.` });
  return value;
}

function optionalEnv(...names: string[]) {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient): Promise<Operator> {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new AdminError("unauthorized", { status: 401 });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new AdminError("unauthorized", { status: 401 });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new AdminError("employee_lookup_failed", { status: 500 });
  if (!employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    throw new AdminError("admin_required", { status: 403 });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function normalizePhone(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const candidate = raw.startsWith("+")
    ? `+${raw.slice(1).replace(/\D/g, "")}`
    : `+${raw.replace(/\D/g, "")}`;
  return /^\+\d{7,15}$/.test(candidate) ? candidate : "";
}

function normalizeUrl(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMessageBody(value: unknown) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function cleanSubscriberSearch(value: unknown) {
  return text(value)
    .replace(/[%*(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, "");
}

function buildFinalSmsBody(message: unknown, linkUrl: unknown) {
  let body = normalizeSpaces(text(message));
  const rawLink = text(linkUrl);
  const link = normalizeUrl(linkUrl);

  if (!body) throw new AdminError("message_required", { status: 400, message: "Message is required." });
  if (rawLink && !link) throw new AdminError("invalid_link", { status: 400, message: "Show link must be a valid http or https URL." });
  if (link && !body.includes(link)) body = `${body} ${link}`;
  if (!/^og jewel(?:ry|ers):/i.test(body)) body = `OG Jewelers: ${body}`;
  if (!/\breply\s+stop\b|\bstop\s+to\s+unsubscribe\b|\bunsubscribe\b/i.test(body)) {
    body = `${body.replace(/[. ]+$/, "")}. Reply STOP to unsubscribe.`;
  }

  body = normalizeSpaces(body);
  if (body.length > 480) {
    throw new AdminError("message_too_long", {
      status: 400,
      message: "SMS body must be 480 characters or less after OG/STOP text is added.",
      details: { length: body.length },
    });
  }
  return body;
}

async function parseResponse(res: Response) {
  const bodyText = await res.text();
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    return { raw: bodyText.slice(0, 1000) };
  }
}

function safeTwilioMessage(payload: unknown) {
  const record = recordOrEmpty(payload);
  return text(record.message || record.more_info || record.error_message || JSON.stringify(payload)).slice(0, 1000);
}

async function sendTwilioSms(toPhone: string, body: string) {
  const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
  const authToken = requiredEnv("TWILIO_AUTH_TOKEN");
  const fromPhone = normalizePhone(optionalEnv("TWILIO_FROM_PHONE", "TWILIO_FROM")) || DEFAULT_FROM_PHONE;
  const statusCallback = normalizeUrl(optionalEnv("TWILIO_STATUS_CALLBACK_URL"));

  const form = new URLSearchParams({
    From: fromPhone,
    To: toPhone,
    Body: body,
  });
  if (statusCallback) form.set("StatusCallback", statusCallback);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const payload = await parseResponse(res);
  if (!res.ok) {
    const twilioCode = text(recordOrEmpty(payload).code);
    throw new TwilioSendError(res.status, twilioCode, safeTwilioMessage(payload), payload);
  }

  const record = recordOrEmpty(payload);
  return {
    sid: text(record.sid),
    status: text(record.status) || "accepted",
    from: text(record.from) || fromPhone,
  };
}

async function getSummary(supabase: ServiceClient) {
  const [subscribed, unsubscribed, total, recentCampaigns] = await Promise.all([
    supabase
      .from("customer_sms_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("status", "subscribed")
      .eq("sms_consent", true)
      .is("opted_out_at", null),
    supabase
      .from("customer_sms_subscribers")
      .select("id", { count: "exact", head: true })
      .eq("status", "unsubscribed"),
    supabase
      .from("customer_sms_subscribers")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("customer_sms_campaigns")
      .select("id,title,final_body,status,recipient_count,sent_count,failed_count,skipped_count,created_at,completed_at,created_by_email")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const errors = [subscribed.error, unsubscribed.error, total.error, recentCampaigns.error]
    .filter(Boolean);
  if (errors.length) throw new AdminError("summary_query_failed", {
    status: 500,
    message: errors.map((error) => error?.message).join("; "),
  });

  return {
    subscribedCount: subscribed.count || 0,
    unsubscribedCount: unsubscribed.count || 0,
    totalCount: total.count || 0,
    recentCampaigns: recentCampaigns.data || [],
  };
}

async function getSubscribers(supabase: ServiceClient, payload: JsonRecord) {
  const search = cleanSubscriberSearch(payload.query);
  const status = text(payload.status).toLowerCase();
  const phoneDigits = digitsOnly(search);
  const limit = Math.max(1, Math.min(Number(payload.limit) || 100, 250));
  let query = supabase
    .from("customer_sms_subscribers")
    .select("phone_e164,name,email,ebay_username,status,source,campaign,opted_in_at,opted_out_at,last_inbound_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (status === "subscribed") {
    query = query
      .eq("status", "subscribed")
      .eq("sms_consent", true)
      .is("opted_out_at", null);
  } else if (status === "unsubscribed") {
    query = query.eq("status", "unsubscribed");
  }

  if (search) {
    const filters = [
      `phone_e164.ilike.%${search}%`,
      `name.ilike.%${search}%`,
      `email.ilike.%${search}%`,
      `ebay_username.ilike.%${search}%`,
    ];
    if (phoneDigits.length >= 2 && phoneDigits !== search) {
      filters.push(`phone_e164.ilike.%${phoneDigits}%`);
    }
    query = query.or(filters.join(","));
  }

  const { data, error } = await query;
  if (error) throw new AdminError("subscriber_search_failed", { status: 500, message: error.message });
  return data || [];
}

function autoMessageForClient(row: Partial<AutoMessageRow>, key: CustomerSmsAutoMessageKey) {
  const defaults = customerSmsAutoMessageDefault(key);
  return {
    key,
    title: text(row.title) || defaults.title,
    description: text(row.description) || defaults.description,
    body: normalizeMessageBody(row.body) || defaults.body,
    fallbackBody: normalizeMessageBody(row.fallback_body) || defaults.body,
    isActive: row.is_active !== false,
    updatedByEmail: text(row.updated_by_email) || null,
    updatedAt: text(row.updated_at) || null,
  };
}

async function getAutoMessages(supabase: ServiceClient) {
  const { data, error } = await supabase
    .from("customer_sms_auto_messages")
    .select("message_key,title,description,body,fallback_body,is_active,updated_by_email,updated_at");

  if (error) throw new AdminError("auto_messages_query_failed", { status: 500, message: error.message });

  const byKey = new Map<string, AutoMessageRow>();
  for (const row of (Array.isArray(data) ? data : []) as AutoMessageRow[]) byKey.set(row.message_key, row);
  return CUSTOMER_SMS_AUTO_MESSAGE_DEFINITIONS.map((defaults) => autoMessageForClient(byKey.get(defaults.key) || {}, defaults.key));
}

async function saveAutoMessage(supabase: ServiceClient, operator: Operator, payload: JsonRecord) {
  const key = text(payload.key || payload.messageKey || payload.message_key);
  if (!isCustomerSmsAutoMessageKey(key)) {
    throw new AdminError("invalid_auto_message", { status: 400, message: "Choose a valid automatic SMS message." });
  }

  const defaults = customerSmsAutoMessageDefault(key);
  const body = normalizeMessageBody(payload.body);
  if (!body) throw new AdminError("auto_message_body_required", { status: 400, message: "Message body is required." });
  if (body.length > 1200) {
    throw new AdminError("auto_message_too_long", {
      status: 400,
      message: "Automatic SMS message must be 1200 characters or less.",
      details: { length: body.length },
    });
  }

  const { data, error } = await supabase
    .from("customer_sms_auto_messages")
    .upsert({
      message_key: key,
      title: defaults.title,
      description: defaults.description,
      body,
      fallback_body: defaults.body,
      is_active: payload.isActive === false ? false : true,
      updated_by: operator.userId,
      updated_by_email: operator.email,
      metadata: {
        updated_from: "sms_marketing_admin",
      },
    }, { onConflict: "message_key" })
    .select("message_key,title,description,body,fallback_body,is_active,updated_by_email,updated_at")
    .single();

  if (error || !data) {
    throw new AdminError("auto_message_save_failed", { status: 500, message: error?.message || "Automatic SMS message was not saved." });
  }

  return autoMessageForClient(data as AutoMessageRow, key);
}

async function recordOptOutFromTwilioBlock(supabase: ServiceClient, phone: string, error: TwilioSendError) {
  if (error.twilioCode !== "21610") return;
  await supabase.rpc("customer_sms_record_opt_out", {
    _phone_e164: phone,
    _opt_out_source: "twilio_blocked",
    _inbound_body: null,
    _metadata: {
      twilio_error_code: error.twilioCode,
      twilio_error_status: error.status,
      twilio_error_message: error.message,
      detected_at: new Date().toISOString(),
    },
  });
}

async function sendCampaign(req: Request, supabase: ServiceClient, operator: Operator, payload: JsonRecord) {
  if (payload.confirm !== SEND_CONFIRMATION && payload.confirmSend !== true) {
    throw new AdminError("confirmation_required", {
      status: 400,
      message: `Set confirm to ${SEND_CONFIRMATION} before sending.`,
    });
  }

  const finalBody = buildFinalSmsBody(payload.message || payload.body, payload.linkUrl || payload.link_url);
  const rawLink = text(payload.linkUrl || payload.link_url);
  const linkUrl = normalizeUrl(rawLink);
  if (rawLink && !linkUrl) {
    throw new AdminError("invalid_link", { status: 400, message: "Show link must be a valid http or https URL." });
  }
  const title = text(payload.title) || `OG SMS ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`;
  const maxRecipients = Math.max(1, Math.min(
    Number(optionalEnv("CUSTOMER_SMS_MAX_RECIPIENTS")) || 500,
    Number(payload.limit) || 500,
  ));

  const { data: subscribers, error: subscriberError } = await supabase
    .from("customer_sms_subscribers")
    .select("id,phone_e164")
    .eq("status", "subscribed")
    .eq("sms_consent", true)
    .is("opted_out_at", null)
    .order("opted_in_at", { ascending: true })
    .limit(maxRecipients);

  if (subscriberError) throw new AdminError("subscriber_query_failed", { status: 500, message: subscriberError.message });
  const audience = (Array.isArray(subscribers) ? subscribers : []) as Subscriber[];
  if (!audience.length) throw new AdminError("no_subscribers", { status: 400, message: "There are no subscribed SMS customers yet." });

  const { data: campaign, error: campaignError } = await supabase
    .from("customer_sms_campaigns")
    .insert({
      title: title.slice(0, 240),
      body: text(payload.message || payload.body).slice(0, 480),
      link_url: linkUrl || null,
      final_body: finalBody,
      status: "sending",
      recipient_count: audience.length,
      created_by: operator.userId,
      created_by_email: operator.email,
      started_at: new Date().toISOString(),
      metadata: {
        requested_from: req.headers.get("origin") || "",
        limited_to: maxRecipients,
        template_id: text(payload.templateId || payload.template_id) || null,
        show_date: text(payload.showDate || payload.show_date) || null,
        show_time: text(payload.showTime || payload.show_time) || null,
      },
    })
    .select("id")
    .single();

  if (campaignError || !campaign?.id) {
    throw new AdminError("campaign_create_failed", { status: 500, message: campaignError?.message || "Campaign was not created." });
  }

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const results: JsonRecord[] = [];

  for (const subscriber of audience) {
    const { data: recipient, error: recipientError } = await supabase
      .from("customer_sms_campaign_recipients")
      .insert({
        campaign_id: campaign.id,
        subscriber_id: subscriber.id,
        phone_e164: subscriber.phone_e164,
        body: finalBody,
        status: "sending",
        attempted_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (recipientError || !recipient?.id) {
      failedCount += 1;
      results.push({ phone: subscriber.phone_e164, status: "failed", error: recipientError?.message || "recipient_create_failed" });
      continue;
    }

    try {
      const twilio = await sendTwilioSms(subscriber.phone_e164, finalBody);
      sentCount += 1;

      await supabase
        .from("customer_sms_campaign_recipients")
        .update({
          status: "sent",
          provider_message_sid: twilio.sid || null,
          twilio_status: twilio.status,
          error_message: null,
          sent_at: new Date().toISOString(),
        })
        .eq("id", recipient.id);

      await supabase.from("customer_sms_events").insert({
        subscriber_id: subscriber.id,
        phone_e164: subscriber.phone_e164,
        from_phone: twilio.from || DEFAULT_FROM_PHONE,
        to_phone: subscriber.phone_e164,
        direction: "outbound",
        event_type: "campaign_send",
        body: finalBody,
        provider_message_sid: twilio.sid || null,
        twilio_status: twilio.status,
        raw_payload: { campaign_id: campaign.id, recipient_id: recipient.id },
      });

      results.push({ phone: subscriber.phone_e164, status: "sent", sid: twilio.sid, twilioStatus: twilio.status });
    } catch (error) {
      const twilioError = error instanceof TwilioSendError ? error : null;
      const blockedByTwilio = twilioError?.twilioCode === "21610";
      const nextStatus = blockedByTwilio ? "skipped" : "failed";
      if (blockedByTwilio) skippedCount += 1;
      else failedCount += 1;

      await supabase
        .from("customer_sms_campaign_recipients")
        .update({
          status: nextStatus,
          twilio_status: twilioError ? `error:${twilioError.twilioCode || twilioError.status}` : "error",
          error_message: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        })
        .eq("id", recipient.id);

      if (twilioError) await recordOptOutFromTwilioBlock(supabase, subscriber.phone_e164, twilioError);

      await supabase.from("customer_sms_events").insert({
        subscriber_id: subscriber.id,
        phone_e164: subscriber.phone_e164,
        from_phone: DEFAULT_FROM_PHONE,
        to_phone: subscriber.phone_e164,
        direction: "outbound",
        event_type: "campaign_failed",
        body: finalBody,
        twilio_status: twilioError ? `error:${twilioError.twilioCode || twilioError.status}` : "error",
        raw_payload: {
          campaign_id: campaign.id,
          recipient_id: recipient.id,
          error: error instanceof Error ? error.message : String(error),
          twilio_code: twilioError?.twilioCode || null,
        },
      });

      results.push({
        phone: subscriber.phone_e164,
        status: nextStatus,
        error: error instanceof Error ? error.message : String(error),
        twilioCode: twilioError?.twilioCode || null,
      });
    }
  }

  const campaignStatus = failedCount === 0 && skippedCount === 0
    ? "sent"
    : sentCount > 0 || skippedCount > 0
      ? "partial_failed"
      : "failed";

  await supabase
    .from("customer_sms_campaigns")
    .update({
      status: campaignStatus,
      sent_count: sentCount,
      failed_count: failedCount,
      skipped_count: skippedCount,
      completed_at: new Date().toISOString(),
    })
    .eq("id", campaign.id);

  return {
    campaignId: campaign.id,
    status: campaignStatus,
    finalBody,
    audienceCount: audience.length,
    sentCount,
    failedCount,
    skippedCount,
    results,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });

  const supabase = serviceClient();

  try {
    const operator = await requireAdmin(req, supabase);
    const payload = recordOrEmpty(await req.json().catch(() => ({})));
    const action = text(payload.action || "summary");

    if (action === "summary") {
      return json(req, 200, { ok: true, summary: await getSummary(supabase) });
    }

    if (action === "subscribers") {
      return json(req, 200, { ok: true, subscribers: await getSubscribers(supabase, payload) });
    }

    if (action === "auto_messages") {
      return json(req, 200, { ok: true, autoMessages: await getAutoMessages(supabase) });
    }

    if (action === "save_auto_message") {
      return json(req, 200, { ok: true, autoMessage: await saveAutoMessage(supabase, operator, payload) });
    }

    if (action === "preview") {
      const finalBody = buildFinalSmsBody(payload.message || payload.body, payload.linkUrl || payload.link_url);
      const summary = await getSummary(supabase);
      return json(req, 200, {
        ok: true,
        preview: {
          finalBody,
          length: finalBody.length,
          audienceCount: summary.subscribedCount,
        },
      });
    }

    if (action === "send") {
      const result = await sendCampaign(req, supabase, operator, payload);
      return json(req, 200, { ok: true, result, summary: await getSummary(supabase) });
    }

    throw new AdminError("invalid_action", { status: 400, message: "Use action summary, subscribers, auto_messages, save_auto_message, preview, or send." });
  } catch (error) {
    const status = error instanceof AdminError ? error.status : 500;
    return json(req, status, {
      ok: false,
      error: error instanceof AdminError ? error.code : "unexpected_error",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof AdminError ? error.details : {},
    });
  }
});
