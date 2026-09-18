export type CustomerSmsAutoMessageKey =
  | "username_prompt"
  | "username_saved"
  | "username_change_prompt"
  | "username_status"
  | "instagram_done";

export type CustomerSmsAutoMessageDefinition = {
  key: CustomerSmsAutoMessageKey;
  title: string;
  description: string;
  body: string;
};

export const CUSTOMER_SMS_AUTO_MESSAGE_DEFINITIONS: CustomerSmsAutoMessageDefinition[] = [
  {
    key: "username_prompt",
    title: "Ask for eBay username",
    description: "Sent after someone texts OG or subscribes by text.",
    body: `💰 WANT A CHANCE TO WIN $100 EVERY DAY? 💰

Join our VIP text list for access to our DAILY GIVEAWAYS $100 SENT VIA ZELLE 🎉🔥

To join, simply reply with your eBay username.

📲 Daily giveaways
💵 $100 sent via Zelle
🎁 Exclusive offers & surprises

Reply with your eBay username to get started! 🍀`,
  },
  {
    key: "username_saved",
    title: "Username received",
    description: "Sent after the customer sends their public eBay username.",
    body: `🎉 CONGRATULATIONS! YOU’RE ALMOST IN! 🎉

We received your eBay username ✅

There’s just ONE LAST STEP to complete your entry for our daily $100 Zelle giveaways 💵🔥

📲 Follow us on Instagram @OGJewelers

Once you’ve followed us, reply DONE and you’re officially entered! 🍀💎`,
  },
  {
    key: "username_change_prompt",
    title: "Change username prompt",
    description: "Sent after a subscribed customer replies CHANGE.",
    body: "OG Jewelers: Send the new eBay username as publicly displayed. Just the public username, nothing more.",
  },
  {
    key: "username_status",
    title: "Username on file",
    description: "Sent when a subscribed customer already has an eBay username saved.",
    body: "OG Jewelers: Your eBay username on file is {{username}}. To change it, reply CHANGE.",
  },
  {
    key: "instagram_done",
    title: "Instagram DONE reply",
    description: "Sent after the customer replies DONE after following Instagram.",
    body: `OG Jewelers: You're officially entered for our daily $100 Zelle giveaways. Good luck!

Instagram verification rule: if you are selected as a winner and were not following @OGJewelers before the winning draw, you will be disqualified and the prize will go to another eligible user.

If you win, you must provide your Instagram username so we can message you there and verify the follow.`,
  },
];

export const CUSTOMER_SMS_AUTO_MESSAGE_DEFAULTS = Object.fromEntries(
  CUSTOMER_SMS_AUTO_MESSAGE_DEFINITIONS.map((item) => [item.key, item]),
) as Record<CustomerSmsAutoMessageKey, CustomerSmsAutoMessageDefinition>;

export const CUSTOMER_SMS_AUTO_MESSAGE_KEYS = new Set<CustomerSmsAutoMessageKey>(
  CUSTOMER_SMS_AUTO_MESSAGE_DEFINITIONS.map((item) => item.key),
);

export function isCustomerSmsAutoMessageKey(value: string): value is CustomerSmsAutoMessageKey {
  return CUSTOMER_SMS_AUTO_MESSAGE_KEYS.has(value as CustomerSmsAutoMessageKey);
}

export function customerSmsAutoMessageDefault(key: CustomerSmsAutoMessageKey) {
  return CUSTOMER_SMS_AUTO_MESSAGE_DEFAULTS[key];
}

export function renderCustomerSmsAutoMessage(body: string, values: Record<string, string | null | undefined> = {}) {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, rawKey) => {
    const key = String(rawKey || "").toLowerCase();
    return values[key] ?? "";
  });
}
