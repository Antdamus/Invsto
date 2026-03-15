import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const EBAY_APP_ID = Deno.env.get("EBAY_APP_ID")!;
const EBAY_DEV_ID = Deno.env.get("EBAY_DEV_ID")!;
const EBAY_CERT_ID = Deno.env.get("EBAY_CERT_ID")!;
const EBAY_AUTH_TOKEN = Deno.env.get("EBAY_AUTH_TOKEN")!;
const EBAY_SITE_ID = Deno.env.get("EBAY_SITE_ID") ?? "0";
const EBAY_COMPATIBILITY_LEVEL = Deno.env.get("EBAY_COMPATIBILITY_LEVEL") ?? "1225";
const EBAY_SELLER_USER_ID = Deno.env.get("EBAY_SELLER_USER_ID") ?? "ogjewelers";

const EBAY_TRADING_URL = "https://api.ebay.com/ws/api.dll";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type EbayFeedbackDetail = {
  CommentingUser?: string;
  CommentText?: string;
  CommentTime?: string;
  CommentType?: string;
  ItemID?: string;
  ItemTitle?: string;
  Role?: string;
  FeedbackID?: string;
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function ebayTradingRequest(callName: string, bodyXml: string): Promise<string> {
  const res = await fetch(EBAY_TRADING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": EBAY_SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": EBAY_COMPATIBILITY_LEVEL,
      "X-EBAY-API-DEV-NAME": EBAY_DEV_ID,
      "X-EBAY-API-APP-NAME": EBAY_APP_ID,
      "X-EBAY-API-CERT-NAME": EBAY_CERT_ID,
    },
    body: bodyXml,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`eBay HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  if (text.includes("<Ack>Failure</Ack>") || text.includes("<Ack>PartialFailure</Ack>")) {
    throw new Error(`eBay API failure: ${text.slice(0, 1000)}`);
  }

  return text;
}

function textContent(parent: Element | null, tagName: string): string | null {
  if (!parent) return null;
  const el = parent.getElementsByTagName(tagName)?.[0];
  return el?.textContent?.trim() || null;
}

function parseFeedbackResponse(xml: string): EbayFeedbackDetail[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (!doc) throw new Error("Unable to parse eBay GetFeedback XML");

  const details = Array.from(doc.getElementsByTagName("FeedbackDetail"));
  return details.map((node) => ({
    CommentingUser: textContent(node, "CommentingUser"),
    CommentText: textContent(node, "CommentText"),
    CommentTime: textContent(node, "CommentTime"),
    CommentType: textContent(node, "CommentType"),
    ItemID: textContent(node, "ItemID"),
    ItemTitle: textContent(node, "ItemTitle"),
    Role: textContent(node, "Role"),
    FeedbackID: textContent(node, "FeedbackID"),
  }));
}

function parseGetItemImage(xml: string): { imageUrl: string | null; itemTitle: string | null } {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (!doc) throw new Error("Unable to parse eBay GetItem XML");

  const itemNode = doc.getElementsByTagName("Item")?.[0] ?? null;
  const title = textContent(itemNode, "Title");

  const galleryUrl =
    textContent(itemNode, "GalleryURL") ||
    textContent(itemNode, "GalleryPlusPictureURL") ||
    textContent(itemNode, "PictureURL");

  if (galleryUrl) {
    return { imageUrl: galleryUrl, itemTitle: title };
  }

  const pictureDetails = itemNode?.getElementsByTagName("PictureDetails")?.[0] ?? null;
  const urls = pictureDetails ? Array.from(pictureDetails.getElementsByTagName("PictureURL")) : [];
  const firstUrl = urls[0]?.textContent?.trim() || null;

  return { imageUrl: firstUrl, itemTitle: title };
}

async function getItemImage(itemId: string): Promise<{ imageUrl: string | null; itemTitle: string | null }> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
      <eBayAuthToken>${escapeXml(EBAY_AUTH_TOKEN)}</eBayAuthToken>
    </RequesterCredentials>
    <ItemID>${escapeXml(itemId)}</ItemID>
    <DetailLevel>ReturnAll</DetailLevel>
  </GetItemRequest>`;

  const responseXml = await ebayTradingRequest("GetItem", xml);
  return parseGetItemImage(responseXml);
}

async function getFeedbackPage(pageNumber: number, entriesPerPage = 50): Promise<EbayFeedbackDetail[]> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
  <GetFeedbackRequest xmlns="urn:ebay:apis:eBLBaseComponents">
    <RequesterCredentials>
      <eBayAuthToken>${escapeXml(EBAY_AUTH_TOKEN)}</eBayAuthToken>
    </RequesterCredentials>
    <UserID>${escapeXml(EBAY_SELLER_USER_ID)}</UserID>
    <DetailLevel>ReturnAll</DetailLevel>
    <FeedbackType>FeedbackReceivedAsSeller</FeedbackType>
    <CommentType>Positive</CommentType>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </GetFeedbackRequest>`;

  const responseXml = await ebayTradingRequest("GetFeedback", xml);
  return parseFeedbackResponse(responseXml);
}

function normalizeBuyerDisplay(_originalName: string | null): string {
  return "Verified eBay buyer";
}

function shouldApproveForHomepage(input: {
  reviewText: string;
  hasPhoto: boolean;
  fallbackItemImageUrl: string | null;
  ratingType: string;
}): boolean {
  const cleanText = input.reviewText.trim();
  return (
    input.ratingType === "positive" &&
    cleanText.length >= 20 &&
    cleanText.length <= 500 &&
    (input.hasPhoto || !!input.fallbackItemImageUrl)
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const maxPages = Number(body?.maxPages ?? 3);
    const entriesPerPage = Number(body?.entriesPerPage ?? 30);

    let fetched = 0;
    let insertedOrUpdated = 0;
    let approved = 0;
    let withFallbackImages = 0;
    let skipped = 0;

    for (let page = 1; page <= maxPages; page++) {
      const feedbacks = await getFeedbackPage(page, entriesPerPage);

      if (!feedbacks.length) break;

      for (const fb of feedbacks) {
        const reviewId = fb.FeedbackID || `${fb.CommentingUser || "anon"}-${fb.CommentTime || Date.now()}-${fb.ItemID || "noitem"}`;
        const reviewText = fb.CommentText?.trim() || "";
        const ratingType = (fb.CommentType || "").toLowerCase();

        if (ratingType !== "positive" || !reviewText) {
          skipped++;
          continue;
        }

        let fallbackItemImageUrl: string | null = null;
        let itemTitle = fb.ItemTitle || null;

        if (fb.ItemID) {
          try {
            const itemData = await getItemImage(fb.ItemID);
            fallbackItemImageUrl = itemData.imageUrl;
            itemTitle = itemTitle || itemData.itemTitle;
            if (fallbackItemImageUrl) withFallbackImages++;
          } catch (err) {
            console.warn(`GetItem failed for ${fb.ItemID}:`, err);
          }
        }

        // TODO: when exact eBay feedback-photo mapping is confirmed, replace this placeholder
        // with the actual review-photo URL from the feedback payload.
        const reviewPhotoUrl: string | null = null;
        const hasPhoto = !!reviewPhotoUrl;

        const row = {
          source: "ebay",
          source_review_id: reviewId,
          source_item_id: fb.ItemID || null,
          rating_type: "positive",
          star_rating: 5,
          review_text: reviewText,
          review_date: fb.CommentTime || null,
          source_buyer_display: normalizeBuyerDisplay(fb.CommentingUser || null),
          original_buyer_name: fb.CommentingUser || null,
          review_photo_url: reviewPhotoUrl,
          fallback_item_image_url: fallbackItemImageUrl,
          item_title: itemTitle,
          has_photo: hasPhoto,
          approved_for_homepage: shouldApproveForHomepage({
            reviewText,
            hasPhoto,
            fallbackItemImageUrl,
            ratingType: "positive",
          }),
          is_active: true,
          raw_payload: fb,
        };

        const { error } = await supabase
          .from("customer_testimonials")
          .upsert(row, { onConflict: "source_review_id" });

        if (error) {
          console.error("Supabase upsert error:", error);
          skipped++;
          continue;
        }

        insertedOrUpdated++;
        if (row.approved_for_homepage) approved++;
      }

      fetched += feedbacks.length;

      if (feedbacks.length < entriesPerPage) {
        break;
      }
    }

    return jsonResponse(200, {
      ok: true,
      fetched,
      insertedOrUpdated,
      approved,
      withFallbackImages,
      skipped,
    });
  } catch (error) {
    console.error("sync-ebay-feedback fatal error:", error);
    return jsonResponse(500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});