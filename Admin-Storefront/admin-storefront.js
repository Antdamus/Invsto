console.log("✅ admin-storefront.js LOADED — build:", new Date().toISOString());

// admin-storefront.js — OG Jewelers
// Requires initSupabase.js to set window.supabase AND dispatch "supabase-ready"

const $ = (sel, root = document) => root.querySelector(sel);

/* =========================
   Config
========================= */

const SUPABASE_PROJECT_URL =
  window.SUPABASE_URL || "https://byhytmarmigalvawkedi.supabase.co";

// ✅ Your PUBLIC bucket name for storefront images
const PUBLIC_PHOTO_BUCKET = "item-photos";

// ✅ Your real storefront channel_id (TEXT) in storefront_listings
const DEFAULT_CHANNEL_ID = "og_main";

// ✅ Login page path (admin file lives in /Admin-Storefront/)
const LOGIN_PATH = "/index.html";

/* =========================
   Supabase bootstrap
========================= */

async function waitForSupabase() {
  if (window.supabase) return window.supabase;

  await new Promise((resolve) => {
    document.addEventListener("supabase-ready", resolve, { once: true });
  });

  return window.supabase;
}

function sb() {
  // Always use window.supabase (never rely on a global "supabase" symbol)
  return window.supabase;
}

/* =========================
   Storage helpers (public URLs)
========================= */

const isHttpUrl = (s) => /^https?:\/\//i.test(String(s || ""));

const publicObjectUrl = (bucket, key) => {
  const k = String(key || "").replace(/^\/+/, "");
  if (!k) return "";
  return `${SUPABASE_PROJECT_URL}/storage/v1/object/public/${bucket}/${encodeURI(k)}`;
};

const pickPreviewKey = (listing) => {
  // 1) Admin override
  const keys = Array.isArray(listing?.public_photo_keys)
    ? listing.public_photo_keys
    : [];
  if (keys[0]) return keys[0];

  // 2) item_types.photo_url
  const it = listing?.item_types || {};
  if (it.photo_url) return it.photo_url; // may be URL or storage key

  // 3) item_types.photos[0]
  const photos = Array.isArray(it.photos) ? it.photos : [];
  return photos[0] || "";
};

const previewUrlFromKeyOrUrl = (kOrUrl) => {
  if (!kOrUrl) return "";
  return isHttpUrl(kOrUrl) ? kOrUrl : publicObjectUrl(PUBLIC_PHOTO_BUCKET, kOrUrl);
};

/* =========================
   State
========================= */

let currentChannelId = null;
let listingsCache = [];
let typingTimer = null;

/* =========================
   Boot
========================= */

document.addEventListener("DOMContentLoaded", async () => {
  try {
    $("#connectionPill").textContent = "Connecting…";

    await waitForSupabase(); // ✅ critical
    $("#connectionPill").textContent = "Supabase connected";

    const ok = await requireAdmin();
    if (!ok) return;

    wireUI();
    await loadChannels();       // sets og_main
    await refreshListings();    // loads cards
  } catch (e) {
    console.error(e);
    toast(`Error booting admin page: ${e?.message || e}`);
  }
});

function wireUI() {
  $("#btnSignOut")?.addEventListener("click", signOut);
  $("#btnRefresh")?.addEventListener("click", refreshListings);

  $("#channelSelect")?.addEventListener("change", async (e) => {
    currentChannelId = e.target.value || DEFAULT_CHANNEL_ID;
    await refreshListings();
  });

  $("#itemSearch")?.addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(runItemSearch, 180);
  });

  $("#searchResults")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action='add-listing']");
    if (!btn) return;
    const itemId = btn.getAttribute("data-item-id");
    await addListing(itemId);
  });

  // Card actions (save/publish/reorder/delete)
  $("#listings")?.addEventListener("click", async (e) => {
    const actionBtn = e.target.closest("[data-action]");
    if (!actionBtn) return;

    const action = actionBtn.getAttribute("data-action");
    const listingId = actionBtn.getAttribute("data-id");

    if (action === "delete") return deleteListing(listingId);
    if (action === "move-up") return moveListing(listingId, -1);
    if (action === "move-down") return moveListing(listingId, +1);
    if (action === "toggle-published") return togglePublished(listingId);
    if (action === "save") return saveListing(listingId);
  });

  // ✅ Cover upload (delegated)
  $("#listings")?.addEventListener("change", async (e) => {
    const input = e.target.closest("input[type='file'][data-action='upload-cover']");
    if (!input) return;

    const listingId = input.getAttribute("data-id");
    const file = input.files && input.files[0];
    if (!listingId || !file) return;

    try {
      input.disabled = true;
      toast("Uploading cover…");

      const safeName = (file.name || "cover").replace(/[^\w.-]+/g, "_");
      const key = `item_photos/storefront/${listingId}/${Date.now()}_${safeName}`;

      const { error: upErr } = await sb()
        .storage
        .from(PUBLIC_PHOTO_BUCKET)
        .upload(key, file, { upsert: true, contentType: file.type || "image/jpeg" });

      if (upErr) throw upErr;

      // Update inputs + preview in UI
      const card = document.querySelector(`.listing-card[data-id="${listingId}"]`);
      const keysInput = card?.querySelector(`[data-field="public_photo_keys"]`);
      const previewImg = card?.querySelector(`[data-role="cover-preview"]`);

      const existing = (keysInput?.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const next = [key, ...existing.filter((x) => x !== key)];
      if (keysInput) keysInput.value = next.join(", ");
      if (previewImg) previewImg.src = publicObjectUrl(PUBLIC_PHOTO_BUCKET, key);

      toast("Uploaded. Click Save changes.");
    } catch (err) {
      console.error("Cover upload failed:", err);
      toast(`Upload failed: ${err?.message || "check Storage policies"}`);
    } finally {
      input.disabled = false;
      input.value = "";
    }
  });
}

/* =========================
   Auth / Admin gate
========================= */

async function requireAdmin() {
  const { data: { session }, error } = await sb().auth.getSession();
  if (error) console.error(error);

  if (!session) {
    window.location.href = LOGIN_PATH;
    return false;
  }

  const userId = session.user.id;

  const { data: roleRow, error: roleErr } = await sb()
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (roleErr) {
    console.error(roleErr);
    $("#adminRolePill").textContent = "Role check failed";
    $("#adminRolePill").classList.add("bad");
    toast(`Role check failed: ${roleErr.message}`);
    return false;
  }

  if (!roleRow || roleRow.role !== "admin") {
    $("#adminRolePill").textContent = "Not an admin";
    $("#adminRolePill").classList.add("bad");
    toast("Access denied. Admins only.");
    window.location.href = LOGIN_PATH;
    return false;
  }

  $("#adminRolePill").textContent = "Admin verified";
  $("#adminRolePill").classList.add("ok");
  return true;
}

async function signOut() {
  await sb().auth.signOut();
  window.location.href = LOGIN_PATH;
}

/* =========================
   Channels (hardcoded to og_main)
========================= */

async function loadChannels() {
  const sel = $("#channelSelect");
  if (!sel) return;

  sel.innerHTML = "";

  const opt = document.createElement("option");
  opt.value = DEFAULT_CHANNEL_ID;
  opt.textContent = DEFAULT_CHANNEL_ID;
  sel.appendChild(opt);

  currentChannelId = DEFAULT_CHANNEL_ID;
}

/* =========================
   Search item_types (for adding listings)
========================= */

async function runItemSearch() {
  const q = ($("#itemSearch")?.value || "").trim();
  const box = $("#searchResults");

  if (!box) return;

  if (!q || q.length < 2) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  const { data, error } = await sb()
    .from("item_types")
    .select("id, title, barcode, categories, metal, purity_basis_points, stock, description")
    .or(`title.ilike.%${q}%,barcode.ilike.%${q}%,description.ilike.%${q}%`)
    .limit(12);

  if (error) {
    console.error(error);
    toast(`Search failed: ${error.message}`);
    return;
  }

  const items = data || [];
  if (!items.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  box.hidden = false;
  box.innerHTML = items.map((it) => {
    const cats = Array.isArray(it.categories) ? it.categories.join(", ") : "";
    const meta = [
      it.barcode ? `Barcode: ${it.barcode}` : null,
      cats ? `Categories: ${cats}` : null,
      it.metal ? `${it.metal}` : null,
      (it.purity_basis_points != null) ? `Purity bp: ${it.purity_basis_points}` : null,
      (it.stock != null) ? `Stock: ${it.stock}` : null,
    ].filter(Boolean).join(" • ");

    return `
      <div class="search-item">
        <div class="meta">
          <div class="title">${escapeHtml(it.title || "Untitled")}</div>
          <p class="sub">${escapeHtml(meta)}</p>
        </div>
        <button class="btn primary" type="button"
          data-action="add-listing"
          data-item-id="${it.id}">
          Add
        </button>
      </div>
    `;
  }).join("");
}

async function addListing(itemTypeId) {
  const channel = currentChannelId || DEFAULT_CHANNEL_ID;

  const payload = {
    channel_id: channel,
    item_type_id: itemTypeId,
    published: false,
    sort_rank: 1000,
    pricing_mode: "fixed",
    premium_basis_points: 0,
    labor_fee: 0,
    rounding_increment: 1,
    badge_flags: [],
    public_photo_keys: [],
  };

  const { error } = await sb()
    .from("storefront_listings")
    .insert(payload);

  if (error) {
    console.error(error);
    toast(`Could not add listing: ${error.message}`);
    return;
  }

  toast("Listing added.");
  await refreshListings();
}

/* =========================
   Listings
========================= */

async function refreshListings() {
  const channel = currentChannelId || $("#channelSelect")?.value || DEFAULT_CHANNEL_ID;
  currentChannelId = channel;

  // DEBUG breadcrumb
  console.log("🔎 refreshListings channel =", channel);

  const { data, error } = await sb()
    .from("storefront_listings")
    .select(`
      id, channel_id, item_type_id, published, published_at, sort_rank,
      public_title, public_description,
      pricing_mode, public_price_override, metal, purity_basis_points,
      premium_basis_points, labor_fee, rounding_increment,
      badge_flags, public_photo_keys,
      item_types (
        id, title, description,
        photos, photo_url,
        metal, purity_basis_points,
        metal_weight_g, stock, categories
      )
    `)
    .eq("channel_id", channel)
    .order("sort_rank", { ascending: true });

  if (error) {
    console.error("❌ listings query failed:", error);
    toast(`Could not load listings: ${error.message}`);
    return;
  }

  listingsCache = data || [];
  $("#listingCountPill").textContent = `${listingsCache.length} listings`;

  renderListings(listingsCache);
}

function renderListings(list) {
  const root = $("#listings");
  const empty = $("#emptyListings");
  if (!root || !empty) return;

  if (!list.length) {
    root.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  root.innerHTML = list.map((l) => {
    const it = l.item_types || {};
    const effectiveTitle = l.public_title || it.title || "Untitled";
    const status = l.published ? "Published" : "Draft";
    const statusDot = l.published ? "🟢" : "🟠";

    const badgeFlags = Array.isArray(l.badge_flags) ? l.badge_flags.join(", ") : "";
    const photoKeys = Array.isArray(l.public_photo_keys) ? l.public_photo_keys.join(", ") : "";

    const previewUrl = previewUrlFromKeyOrUrl(pickPreviewKey(l)) || "";

    return `
      <div class="listing-card" data-id="${l.id}">
        <div class="listing-top">
          <div class="listing-title">
            <div class="name">${escapeHtml(effectiveTitle)}</div>
            <div class="small">${statusDot} ${status} • sort_rank: ${l.sort_rank ?? "—"} • item: ${escapeHtml(it.title || "")}</div>
          </div>

          <div class="actions">
            <button class="btn ghost icon-btn" type="button" data-action="move-up" data-id="${l.id}" aria-label="Move up">↑</button>
            <button class="btn ghost icon-btn" type="button" data-action="move-down" data-id="${l.id}" aria-label="Move down">↓</button>
            <button class="btn ghost" type="button" data-action="toggle-published" data-id="${l.id}">
              ${l.published ? "Unpublish" : "Publish"}
            </button>
            <button class="btn ghost" type="button" data-action="delete" data-id="${l.id}">Delete</button>
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label>Cover preview</label>
            <img
              data-role="cover-preview"
              src="${escapeAttr(previewUrl)}"
              alt="Cover preview"
              style="width:100%; max-height:220px; object-fit:cover; border-radius:14px; border:1px solid rgba(255,255,255,.10); background: rgba(7,7,8,.35);"
              loading="lazy"
            />
            <div class="hint">Uses <span class="mono">public_photo_keys[0]</span> when set.</div>
          </div>

          <div class="field">
            <label>Upload cover</label>
            <input type="file" accept="image/*" data-action="upload-cover" data-id="${l.id}" />
            <div class="hint">Uploads to <span class="mono">${escapeHtml(PUBLIC_PHOTO_BUCKET)}</span>.</div>
          </div>
        </div>

        <div class="row">
          <div class="field">
            <label>Public title</label>
            <input type="text" data-field="public_title" value="${escapeAttr(l.public_title || "")}" placeholder="${escapeAttr(it.title || "Title")}" />
          </div>
          <div class="field">
            <label>Sort rank</label>
            <input type="number" data-field="sort_rank" value="${escapeAttr(String(l.sort_rank ?? 1000))}" />
          </div>
        </div>

        <div class="field">
          <label>Public description</label>
          <textarea data-field="public_description" placeholder="Overrides item_types.description">${escapeHtml(l.public_description || "")}</textarea>
        </div>

        <div class="row">
          <div class="field">
            <label>Badge flags (comma-separated)</label>
            <input type="text" data-field="badge_flags" value="${escapeAttr(badgeFlags)}" placeholder="new, featured, limited" />
          </div>
          <div class="field">
            <label>Public photo keys (comma-separated)</label>
            <input type="text" data-field="public_photo_keys" value="${escapeAttr(photoKeys)}" placeholder="item_photos/abc.jpg, item_photos/def.jpg" />
          </div>
        </div>

        <div class="actions">
          <button class="btn primary" type="button" data-action="save" data-id="${l.id}">Save changes</button>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================
   Card actions
========================= */

async function saveListing(listingId) {
  const card = document.querySelector(`.listing-card[data-id="${listingId}"]`);
  if (!card) return;

  const getVal = (field) => {
    const el = card.querySelector(`[data-field="${field}"]`);
    return el ? el.value : "";
  };

  const badgeFlags = (getVal("badge_flags") || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const photoKeys = (getVal("public_photo_keys") || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const payload = {
    public_title: nullify(getVal("public_title")),
    public_description: nullify(getVal("public_description")),
    sort_rank: toInt(getVal("sort_rank"), 1000),
    badge_flags: badgeFlags,
    public_photo_keys: photoKeys,
  };

  const { error } = await sb()
    .from("storefront_listings")
    .update(payload)
    .eq("id", listingId);

  if (error) {
    console.error(error);
    toast(`Save failed: ${error.message}`);
    return;
  }

  toast("Saved.");
  await refreshListings();
}

async function togglePublished(listingId) {
  const l = listingsCache.find(x => x.id === listingId);
  if (!l) return;

  const next = !l.published;

  const { error } = await sb()
    .from("storefront_listings")
    .update({
      published: next,
      published_at: next ? new Date().toISOString() : null,
    })
    .eq("id", listingId);

  if (error) {
    console.error(error);
    toast(`Publish toggle failed: ${error.message}`);
    return;
  }

  toast(next ? "Published." : "Unpublished.");
  await refreshListings();
}

async function deleteListing(listingId) {
  const ok = confirm("Delete this listing? (Does not delete item type.)");
  if (!ok) return;

  const { error } = await sb()
    .from("storefront_listings")
    .delete()
    .eq("id", listingId);

  if (error) {
    console.error(error);
    toast(`Delete failed: ${error.message}`);
    return;
  }

  toast("Deleted.");
  await refreshListings();
}

async function moveListing(listingId, dir) {
  const idx = listingsCache.findIndex(x => x.id === listingId);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= listingsCache.length) return;

  const a = listingsCache[idx];
  const b = listingsCache[swapIdx];

  const aRank = a.sort_rank ?? 1000;
  const bRank = b.sort_rank ?? 1000;

  const { error: e1 } = await sb()
    .from("storefront_listings")
    .update({ sort_rank: bRank })
    .eq("id", a.id);

  if (e1) { console.error(e1); toast(`Reorder failed: ${e1.message}`); return; }

  const { error: e2 } = await sb()
    .from("storefront_listings")
    .update({ sort_rank: aRank })
    .eq("id", b.id);

  if (e2) { console.error(e2); toast(`Reorder failed: ${e2.message}`); return; }

  toast("Reordered.");
  await refreshListings();
}

/* =========================
   UI helpers
========================= */

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.hidden = true), 2400);
}

function nullify(v) {
  const s = (v ?? "").trim();
  return s.length ? s : null;
}

function toInt(v, fallback) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("\n", " ");
}
