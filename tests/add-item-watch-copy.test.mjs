import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../supabase/functions/generate-inventory-copy/index.ts", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "");

const sourceUrl = "https://www.rolex.com/watches/datejust/m126233-0035";
const research = (overrides = {}) => ({
  status: "found", matchedName: "Rolex Datejust", matchedReference: "126233",
  facts: [{ label: "Case diameter", value: "36 mm", sourceUrl }],
  warnings: ["Confirm the dial and bracelet variant."], ...overrides,
});

function handler({ ai = false, lookup = research(), searchFails = false, copyFails = false, searchSources = [sourceUrl] } = {}) {
  let serveHandler, aiRequest;
  const requests = [];
  let signCount = 0;
  const context = {
    Request, Response, AbortSignal, URL, console: { log() {}, error() {} },
    Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test", ...(ai ? { OPENAI_API_KEY: "test", OPENAI_MODEL: "test" } : {}) })[name] } },
    serve: (fn) => { serveHandler = fn; },
    createClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => { signCount++; return { data: { signedUrl: "https://example.invalid/photo.jpg" } }; } }) } }),
    fetch: async (_url, options) => {
      aiRequest = JSON.parse(options.body);
      requests.push(aiRequest);
      if (aiRequest.tools) {
        if (searchFails) throw new Error("Lookup timed out");
        return new Response(JSON.stringify({
          output_text: JSON.stringify(lookup),
          output: [{ type: "web_search_call", status: "completed", action: { sources: searchSources.map((url) => ({ url, title: "Reference specifications" })) } }],
        }));
      }
      if (copyFails) return new Response("Unavailable", { status: 503 });
      return new Response(JSON.stringify({ output_text: JSON.stringify({ generatedTitle: "Watch", generatedDescription: "Watch description" }) }));
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(source), context);
  return { invoke: (body) => serveHandler(new Request("https://example.invalid", { method: "POST", body: JSON.stringify(body) })), request: () => aiRequest, requests, signCount: () => signCount };
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

const referenceOnlyWatch = {
  itemKind: "watch", watchDetails: { name: "Rolex", model: "126233", materials: "Steel case", modifications: "Aftermarket diamond bezel" },
};

test("reference-only watches search the exact model, return sourced facts and skip image signing", async () => {
  const api = handler({ ai: true });
  const response = await api.invoke(referenceOnlyWatch);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.watchReference.status, "found");
  assert.equal(result.watchReference.facts[0].sourceUrl, sourceUrl);
  assert.equal(api.signCount(), 0);
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[0].tools[0].type, "web_search");
  assert.equal(api.requests[0].tool_choice, "required");
  assert.match(api.requests[0].input[1].content, /126233/);
  assert.doesNotMatch(api.requests[0].input[1].content, /Aftermarket/, "Only model identity goes to research");
  assert.equal(api.request().input[1].content.length, 1, "No empty image attachment");
  assert.match(api.request().input[1].content[0].text, /36 mm/);
  assert.match(api.request().input[0].content[0].text, /modifications ALWAYS OVERRIDE stock specifications/);
  assert.match(api.request().input[1].content[0].text, /Aftermarket diamond bezel/);
});

test("ambiguous, absent and mismatched references never contribute stock specifications", async () => {
  for (const lookup of [research({ status: "ambiguous" }), research({ status: "not_found" }), research({ matchedReference: "126233-0035" })]) {
    const api = handler({ ai: true, lookup });
    const result = await (await api.invoke(referenceOnlyWatch)).json();
    assert.notEqual(result.watchReference.status, "found");
    assert.deepEqual(result.watchReference.facts, []);
    assert.doesNotMatch(api.request().input[1].content[0].text, /36 mm/);
  }
});

test("unretrieved and unsafe source URLs cannot support a watch fact", async () => {
  for (const searchSources of [[], ["javascript:alert(1)"], ["https://127.0.0.1/watch"]]) {
    const url = searchSources[0] || sourceUrl;
    const api = handler({ ai: true, searchSources, lookup: research({ facts: [{ label: "Movement", value: "Unsupported fact", sourceUrl: url }] }) });
    const result = await (await api.invoke(referenceOnlyWatch)).json();
    assert.equal(result.watchReference.status, "not_found");
  }
  const api = handler({ ai: true, searchSources: ["https://www.rolex.com/other"] });
  const result = await (await api.invoke(referenceOnlyWatch)).json();
  assert.equal(result.watchReference.status, "not_found");
  assert.doesNotMatch(api.request().input[1].content[0].text, /36 mm/);
});

test("lookup failures and missing AI config return explicit limitations without invented specifications", async () => {
  for (const options of [{ ai: true, searchFails: true }, {}]) {
    const api = handler(options);
    const response = await api.invoke(referenceOnlyWatch);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.watchReference.status, "unavailable");
    assert.match(result.watchReference.warnings[0], /unavailable/);
    assert.deepEqual(result.watchReference.facts, []);
  }
  const api = handler({ ai: true, copyFails: true });
  const result = await (await api.invoke(referenceOnlyWatch)).json();
  assert.equal(result.mode, "placeholder");
  assert.match(result.generatedDescription, /Aftermarket diamond bezel/);
  assert.doesNotMatch(result.generatedDescription, /36 mm/);
  assert.equal((await api.invoke({ itemKind: "watch", watchDetails: { name: "Rolex" } })).status, 400);
});
