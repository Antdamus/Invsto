import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../supabase/functions/generate-inventory-copy/index.ts", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "");

function handler({ ai = false } = {}) {
  let serveHandler, aiRequest;
  const context = {
    Request, Response, console: { log() {}, error() {} },
    Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test", ...(ai ? { OPENAI_API_KEY: "test", OPENAI_MODEL: "test" } : {}) })[name] } },
    serve: (fn) => { serveHandler = fn; },
    createClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://example.invalid/photo.jpg" } }) }) } }),
    fetch: async (_url, options) => {
      aiRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({ output_text: JSON.stringify({ generatedTitle: "Watch", generatedDescription: "Watch description" }) }));
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(source), context);
  return { invoke: (body) => serveHandler(new Request("https://example.invalid", { method: "POST", body: JSON.stringify(body) })), request: () => aiRequest };
}

test("watch copy accepts mixed materials and modifications without requiring metal, purity or weight", async () => {
  const api = handler();
  const response = await api.invoke({
    itemKind: "watch", imagePath: "watch.jpg", material: "Silver", purity: "925", weight: null,
    watchDetails: { name: "Rolex Datejust", model: "126233", materials: "Steel case and gold bezel", modifications: "Aftermarket diamonds" },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.generatedTitle, "Rolex Datejust 126233");
  assert.match(result.generatedDescription, /Steel case and gold bezel/);
  assert.match(result.generatedDescription, /Aftermarket diamonds/);
  assert.doesNotMatch(result.generatedDescription, /925|Silver|0\.00 g|unmodified/i);
});

test("watch name and jewelry measurement requirements are enforced independently", async () => {
  const api = handler();
  assert.equal((await api.invoke({ itemKind: "watch", imagePath: "watch.jpg", watchDetails: { name: " " } })).status, 400);
  assert.equal((await api.invoke({ imagePath: "ring.jpg", material: "Silver", purity: "925", weight: null })).status, 400);
  const valid = await api.invoke({ imagePath: "ring.jpg", material: "Silver", purity: "925", weight: 12 });
  assert.equal(valid.status, 200);
  assert.match((await valid.json()).generatedDescription, /12\.00 g/);
});

test("AI request carries watch facts and removes stale single-material metadata", async () => {
  const api = handler({ ai: true });
  await api.invoke({ itemKind: "watch", imagePath: "watch.jpg", material: "Silver", purity: "925", watchDetails: { name: "Custom watch", materials: "Steel case, leather strap", modifications: "Replacement dial" } });
  const request = api.request();
  const prompt = request.input[1].content[0].text;
  assert.match(prompt, /Steel case, leather strap/);
  assert.match(prompt, /Replacement dial/);
  assert.doesNotMatch(prompt, /925|Silver/);
  assert.match(request.input[0].content[0].text, /never describe the entire watch as one metal/i);
});
