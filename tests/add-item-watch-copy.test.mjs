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

function handler({ ai = false, lookup = research(), searchFails = false, copyFails = false, searchSources = [sourceUrl], copy = { generatedTitle: "Watch", generatedDescription: "Watch description" } } = {}) {
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
      return new Response(JSON.stringify({ output_text: JSON.stringify(copy) }));
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../inventory-item-facts.js', import.meta.url), 'utf8'), context);
  vm.runInContext(stripTypeScriptTypes(source), context);
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
  assert.equal(result.generatedTitle, "Rolex Datejust 126233 — Aftermarket");
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

test('watch card choice reaches AI and unchecked cards never imply absence or inclusion',async()=>{
  for(const cardIncluded of ['yes','no','']) {
    const api=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:'Polished case.'}});
    const result=await (await api.invoke({...referenceOnlyWatch,watchDetails:{...referenceOnlyWatch.watchDetails,cardIncluded}})).json();
    assert.match(api.request().input[1].content[0].text,new RegExp(cardIncluded==='yes'?'Card included':cardIncluded==='no'?'No card included':'Card not checked'));
    assert.match(api.request().input[0].content[0].text,/does not establish an active warranty/);
    if(cardIncluded==='yes') assert.match(result.generatedDescription,/Original brand \/ warranty card included/);
    else if(cardIncluded==='no') assert.match(result.generatedDescription,/No brand \/ warranty card included/);
    else assert.doesNotMatch(result.generatedDescription,/card/i);
  }
});

test('AI cannot override card status, and a legitimate no-card statement is not a positive claim',async()=>{
  for(const [cardIncluded,description] of [['','Includes a warranty card.'],['','No warranty card included.'],['no','Warranty card included.'],['yes','Without a warranty card.']]) {
    const api=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:description}});
    const result=await (await api.invoke({...referenceOnlyWatch,watchDetails:{...referenceOnlyWatch.watchDetails,cardIncluded}})).json();
    assert.ok(!result.generatedDescription.includes(description),'Unsupported claim must be rejected');
  }
  const api=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:'Polished case. No warranty card included.'}});
  const result=await (await api.invoke({...referenceOnlyWatch,watchDetails:{...referenceOnlyWatch.watchDetails,cardIncluded:'no'}})).json();
  assert.match(result.generatedDescription,/Polished case/,'Valid descriptive prose is retained');
  assert.equal((result.generatedDescription.match(/card included/gi)||[]).length,1);
});

test('movement-only watches retain disclosure but do not reuse factory exterior dimensions', async()=>{
  const api=handler({ai:true,lookup:research({facts:[{label:'Case dimensions',value:'39.8 mm wide',sourceUrl},{label:'Movement',value:'Automatic',sourceUrl}]}),copy:{generatedTitle:'Watch',generatedDescription:'Custom watch.'}});
  const result=await (await api.invoke({...referenceOnlyWatch,length:'18 inches stale jewelry length',watchDetails:{brand:'Cartier',name:'Santos',model:'126233',modificationPreset:'movement_only',modifications:'Custom dial',braceletFit:'7 inches'}})).json();
  assert.match(result.generatedDescription,/Only the Cartier movement is original; all other parts are aftermarket/);
  assert.match(result.generatedDescription,/7 inches/);
  assert.match(result.generatedTitle,/Aftermarket/);
  assert.equal(result.watchReference.facts[0].value,'39.8 mm wide','Factory research remains available, labeled separately');
  const prompt=api.request().input[1].content[0].text;
  assert.doesNotMatch(prompt,/39\.8|18 inches/);
  assert.doesNotMatch(prompt,/Automatic/,'An original brand movement does not confirm the exact factory caliber');
});

test('private serial is not sent to either AI request or included in public copy',async()=>{
  const api=handler({ai:true});
  const result=await (await api.invoke({...referenceOnlyWatch,notes:'Serial: PRIVATE-123. Box included.',existingDescription:'PRIVATE-123',watchDetails:{...referenceOnlyWatch.watchDetails,serial:'PRIVATE-123',name:'Rolex PRIVATE-123'}})).json();
  assert.doesNotMatch(JSON.stringify(api.requests),/PRIVATE-123/);
  assert.doesNotMatch(result.generatedTitle+result.generatedDescription,/PRIVATE-123/);
});

test('generated watch titles exclude serials, keep model references and enforce aftermarket disclosure', async () => {
  const api = handler({ai:true,copy:{generatedTitle:'Cartier WSSA0007 SERIAL ABC12345',generatedDescription:'An elegant watch with a diamond bezel.'}});
  const result = await (await api.invoke({itemKind:'watch',imagePath:'watch.jpg',stoneType:'Earth-mined diamonds',watchDetails:{brand:'Cartier',name:'Santos Serial ABC12345',model:'WSSA0007',modifications:'Aftermarket diamond bezel'}})).json();
  assert.equal(result.generatedTitle,'Cartier Santos WSSA0007 — Aftermarket, Earth-mined diamonds');
  assert.doesNotMatch(result.generatedTitle,/serial|ABC12345/i);
  assert.match(result.generatedDescription,/Aftermarket diamond bezel/);
  assert.match(result.generatedDescription,/Earth-mined diamonds/);
  assert.doesNotMatch(api.requests[0].input[1].content,/ABC12345/);
});

test('AI cannot turn aftermarket diamonds into factory diamonds or change confirmed origin', async () => {
  for (const description of ['This watch has factory-set diamonds.','An elegant watch set with lab-grown diamonds.']) {
    const api = handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:description}});
    const result = await (await api.invoke({...referenceOnlyWatch,stoneType:'Earth-mined diamonds'})).json();
    assert.match(result.generatedDescription,/Aftermarket/);
    assert.match(result.generatedDescription,/Earth-mined diamonds/);
    assert.doesNotMatch(result.generatedDescription,/factory-set|lab-grown/i);
  }
});

test('a photo or factory reference cannot supply an unconfirmed diamond origin', async () => {
  const api = handler({ai:true,copy:{generatedTitle:'Natural diamond watch',generatedDescription:'The watch has natural diamonds.'}});
  const result = await (await api.invoke({...referenceOnlyWatch,stoneType:'Diamonds (origin unspecified)'})).json();
  assert.doesNotMatch(result.generatedDescription,/natural diamonds/i);
  assert.match(result.generatedDescription,/origin unspecified/);
});

test('AI uses confirmed factory setting independently of unrelated aftermarket modifications',async()=>{
  const description='Factory-set earth-mined diamonds. Aftermarket bracelet / strap.';
  const api=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:description}});
  const result=await (await api.invoke({itemKind:'watch',stoneType:'Earth-mined diamonds',watchDetails:{brand:'Rolex',name:'Datejust',model:'126233',stoneSetting:'factory',modificationPreset:'aftermarket_bracelet'}})).json();
  assert.equal(result.generatedDescription,description);
  assert.match(result.generatedTitle,/Factory-set stones/);
  assert.match(api.request().input[1].content[0].text,/Stone setting origin.*Factory-set stones/);
});

test('AI cannot fill in unknown stone setting from a factory reference or photo',async()=>{
  for (const stoneSetting of [undefined,'unknown','aftermarket']) {
    const api=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:'Factory-set diamonds adorn this piece.'}});
    const result=await (await api.invoke({itemKind:'watch',stoneType:'Earth-mined diamonds',watchDetails:{name:'Rolex',model:'126233',stoneSetting}})).json();
    assert.doesNotMatch(result.generatedDescription,/Factory-set/i);
    if(stoneSetting==='aftermarket') assert.match(result.generatedDescription,/Aftermarket stone setting/);
  }
});

test('AI cannot relabel confirmed factory stones as aftermarket or override movement-only scope',async()=>{
  const api=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:'Aftermarket-set earth-mined diamonds.'}});
  const result=await (await api.invoke({itemKind:'watch',stoneType:'Earth-mined diamonds',watchDetails:{name:'Rolex',model:'126233',stoneSetting:'factory'}})).json();
  assert.match(result.generatedDescription,/Factory-set stones/);
  assert.doesNotMatch(result.generatedDescription,/Aftermarket/i);
  const scoped=handler({ai:true,copy:{generatedTitle:'Watch',generatedDescription:'Factory-set diamonds.'}});
  const second=await (await scoped.invoke({itemKind:'watch',stoneType:'Earth-mined diamonds',watchDetails:{brand:'Cartier',name:'Santos',model:'WSSA0018',stoneSetting:'factory',modificationPreset:'movement_only'}})).json();
  assert.doesNotMatch(second.generatedDescription,/Factory-set/i);
  assert.match(second.generatedDescription,/all other parts are aftermarket/);
  assert.match(second.generatedDescription,/Aftermarket stone setting/);
});
test('VVS simulated diamonds remain explicitly simulated even if generated copy drops the qualifier', async () => {
  const api=handler({ai:true,copy:{generatedTitle:'VVS diamond watch',generatedDescription:'An elegant watch with VVS diamonds.'}});
  const result=await (await api.invoke({...referenceOnlyWatch,stoneType:'VVS simulated diamonds'})).json();
  assert.match(result.generatedTitle,/VVS simulated diamonds/);
  assert.match(result.generatedDescription,/VVS simulated diamonds/);
  assert.doesNotMatch(result.generatedDescription,/with VVS diamonds/);
});

test("coin drafts preserve identity, fineness, condition and fine content without requiring a photo or weight", async () => {
  const api = handler();
  const response = await api.invoke({ itemKind: "coin", material: "Silver", purity: "925", coinDetails: {
    name: "Collector coin", year: "1776–1976", country: "United States", denomination: "$1", mint: "S",
    metal: "Gold", fineness: "916.7", fineMetalContent: "1 troy oz gold", condition: "Circulated", notes: "Cleaned; rim damage",
  } });
  assert.equal(response.status, 200);
  const copy = await response.json();
  assert.match(copy.generatedDescription, /916.7/);
  assert.match(copy.generatedDescription, /1 troy oz gold/);
  assert.match(copy.generatedDescription, /Cleaned; rim damage/);
  assert.match(copy.generatedDescription, /Raw \/ ungraded/);
  assert.doesNotMatch(copy.generatedDescription, /925|Silver|Total weight|rare|authentic/i);
  assert.equal(api.signCount(), 0);
  assert.equal(copy.watchReference, null);
});

test("coin validation rejects missing identity, impossible purity and incomplete grading claims", async () => {
  const api = handler();
  for (const coinDetails of [ {}, { name: "Coin", metal: "Gold", fineness: "1001" }, { name: "Coin", metal: "Silver", fineness: "-1" }, { name: "Coin", gradingStatus: "certified", grade: "MS 65" }, { name: "Coin", gradingStatus: "self-assessed" }, { name: "Coin", gradingStatus: "made-up" } ]) {
    assert.equal((await api.invoke({ itemKind: "coin", coinDetails })).status, 400);
  }
  const valid = await api.invoke({ itemKind: "coin", coinDetails: { name: "Coin", gradingStatus: "certified", grade: "AU details", gradingService: "NGC", certNumber: "001234-001", notes: "Cleaned" } });
  assert.equal(valid.status, 200);
  const copy = await valid.json();
  assert.match(copy.generatedDescription, /AU details/);
  assert.match(copy.generatedDescription, /001234-001/);
});

test("coin AI uses its own facts and prompt, omitting stale jewelry and inactive certification details", async () => {
  const api = handler({ ai: true });
  await api.invoke({ itemKind: "coin", material: "Silver", purity: "925", stoneType: "Diamond", watchDetails: { name: "Rolex", model: "126233" }, coinDetails: { name: "Copper coin", year: "1909", gradingStatus: "ungraded", grade: "MS 70", gradingService: "PCGS", certNumber: "old-cert", notes: "Scratched" } });
  assert.equal(api.requests.length, 1, "Coins do not invoke watch research");
  const request = api.request();
  assert.equal(request.input[1].content.length, 1);
  const prompt = request.input[1].content[0].text;
  assert.match(prompt, /1909|Scratched/);
  assert.doesNotMatch(prompt, /925|Silver|Diamond|Rolex|MS 70|PCGS|old-cert/);
  assert.match(request.input[0].content[0].text, /self-assessed grades must explicitly say seller-assessed/i);
  assert.match(request.input[0].content[0].text, /Proof is a strike\/finish/);
});

test("plated coins and seller-assessed grades cannot inherit solid-metal or certification claims", async () => {
  const api = handler();
  const result = await (await api.invoke({ itemKind: "coin", coinDetails: { name: "Commemorative", metal: "Plated / clad", fineness: "999", composition: "Gold plating over copper", gradingStatus: "self-assessed", grade: "AU 50", gradingService: "PCGS", certNumber: "old-cert" } })).json();
  assert.match(result.generatedDescription, /Gold plating over copper/);
  assert.match(result.generatedDescription, /Seller-assessed grade/);
  assert.doesNotMatch(result.generatedDescription, /999|PCGS|old-cert/);
});

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
