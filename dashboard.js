/** =================== Auth (Admin Only) =================== */
/** =================== Supabase Ready Guard =================== */
function waitForSupabaseReady(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve(window.supabase);

    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Supabase not ready (timeout). Did initSupabase.js load and finish?"));
    }, timeoutMs);

    document.addEventListener("supabase-ready", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(window.supabase);
    }, { once: true });
  });
}


async function checkAuth() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();

  // Not logged in -> go to login
  if (sessionError) console.error("❌ Session error:", sessionError);
  if (!session) {
    window.location.href = "index.html";
    return false;
  }

  const userId = session.user.id;

  // Fetch the employee record for the current user (RLS allows self-select)
  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (employeeError) {
    console.error("❌ Failed to fetch employee record:", employeeError);
    window.location.href = "index.html";
    return false;
  }

  // If no employee record exists, treat as unauthorized
  if (!employee) {
    console.warn("⚠️ No employee record found for user:", userId);
    window.location.href = "index.html";
    return false;
  }

  // Optional: if employee is inactive, block access
  if (employee.active === false) {
    console.warn("⚠️ Employee is inactive:", userId);
    window.location.href = "index.html";
    return false;
  }

  const role = String(employee.role || "").toLowerCase();

  // Not admin -> redirect to worker dashboard (future page)
  if (role !== "admin") {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  // Admin -> allowed
  const greeting = document.getElementById("admin-greeting");
  if (greeting) {
    const name = employee.display_name ? `, ${employee.display_name}` : "";
    greeting.textContent = `Welcome, Admin${name}`;
  }

  return true;
}

/** =================== Active Nav =================== */
function setActiveNavLink() {
  const path = (location.pathname || "").split("/").pop() || "dashboard.html";
  document.querySelectorAll(".nav-link").forEach(a => {
    const href = (a.getAttribute("href") || "").split("/").pop();
    if (href && href === path) a.classList.add("active");
  });
}

/** =================== Formatters =================== */
const fmtMoney = (n) => `$${Number(n || 0).toLocaleString()}`;

/** =================== Data Loading =================== */
async function loadInventoryData() {
  const { data: itemTypes, error: itemTypeError } = await supabase
    .from("item_types")
    .select("*");

  const { data: stockData, error: stockError } = await supabase
    .from("item_stock_locations")
    .select("item_id, quantity");

  if (itemTypeError || stockError) {
    console.error("❌ Failed to fetch data", itemTypeError || stockError);
    return [];
  }

  const quantityMap = {};
  for (const stock of (stockData || [])) {
    if (!quantityMap[stock.item_id]) quantityMap[stock.item_id] = 0;
    quantityMap[stock.item_id] += stock.quantity;
  }

  const allItems = [];
  for (const item of (itemTypes || [])) {
    const quantity = quantityMap[item.id] || 0;
    const categoryList = Array.isArray(item.categories) ? item.categories : [];
    if (quantity > 0 && !categoryList.includes("testcard")) {
      allItems.push({
        ...item,
        quantity,
        totalCost: Number(item.cost || 0) * quantity,
        totalValue: Number(item.sale_price || 0) * quantity,
      });
    }
  }

  return allItems;
}

/** =================== Data Summary =================== */
function computeSummaryByCategory(items) {
  const summary = {
    totalItems: 0,
    totalCost: 0,
    totalValue: 0,
    categories: {},
  };

  for (const item of (items || [])) {
    const categoryList = Array.isArray(item.categories) ? item.categories : [];
    if (categoryList.includes("testcard")) continue;

    const quantity = Number(item.quantity || 0);
    const totalCost = Number(item.totalCost || 0);
    const totalValue = Number(item.totalValue || 0);

    summary.totalItems += quantity;
    summary.totalCost += totalCost;
    summary.totalValue += totalValue;

    for (const category of categoryList) {
      if (!summary.categories[category]) {
        summary.categories[category] = {
          category,
          quantity: 0,
          totalCost: 0,
          totalValue: 0,
        };
      }

      summary.categories[category].quantity += quantity;
      summary.categories[category].totalCost += totalCost;
      summary.categories[category].totalValue += totalValue;
    }
  }

  return summary;
}

/** =================== UI Rendering =================== */
function renderMetricCards(summary) {
  const container = document.getElementById("metric-cards");
  if (!container) return;

  const markup = summary.totalCost ? (summary.totalValue / summary.totalCost) : null;

  container.innerHTML = `
    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Value</div>
        <div class="metric-icon">💎</div>
      </div>
      <div class="metric-value">${fmtMoney(summary.totalValue)}</div>
      <div class="metric-foot">Estimated retail value</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Items</div>
        <div class="metric-icon">📦</div>
      </div>
      <div class="metric-value">${Number(summary.totalItems || 0).toLocaleString()}</div>
      <div class="metric-foot">Units currently in stock</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Cost</div>
        <div class="metric-icon">🧾</div>
      </div>
      <div class="metric-value">${fmtMoney(summary.totalCost)}</div>
      <div class="metric-foot">Total inventory cost basis</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Avg Markup</div>
        <div class="metric-icon">📈</div>
      </div>
      <div class="metric-value">${markup ? `${markup.toFixed(2)}x` : "—"}</div>
      <div class="metric-foot">Value / cost multiplier</div>
    </div>
  `;
}

function getSortedCategories(summary) {
  return Object.values(summary.categories || {})
    .filter(c => c && c.category)
    .sort((a, b) => (Number(b.totalValue || 0) - Number(a.totalValue || 0)));
}

function renderCategoryTable(summary) {
  const tableContainer = document.getElementById("inventory-table-container");
  if (!tableContainer) return;

  const categories = getSortedCategories(summary);

  if (!categories.length) {
    tableContainer.innerHTML = `
      <div class="table-wrapper">
        <div style="padding:16px; color: rgba(242,243,245,.72);">
          No inventory data to display yet.
        </div>
      </div>
    `;
    return;
  }

  const rows = categories.map(cat => `
    <tr>
      <td>${cat.category}</td>
      <td>${Number(cat.quantity || 0).toLocaleString()}</td>
      <td>${fmtMoney(cat.totalCost)}</td>
      <td>${fmtMoney(cat.totalValue)}</td>
      <td>${cat.totalCost ? (cat.totalValue / cat.totalCost).toFixed(2) : '—'}x</td>
    </tr>
  `).join("");

  tableContainer.innerHTML = `
    <div class="table-wrapper">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Category</th>
            <th># Items</th>
            <th>Total Cost</th>
            <th>Total Value</th>
            <th>Avg Markup</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/** =================== Chart =================== */
let _categoryChart = null;

function renderCategoryChart(summary) {
  const canvas = document.getElementById("category-chart");
  if (!canvas) return;

  const categories = getSortedCategories(summary);
  const ctx = canvas.getContext("2d");

  // If no categories, clear chart area gracefully
  if (!categories.length) {
    if (_categoryChart) {
      _categoryChart.destroy();
      _categoryChart = null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Prevent duplicate instances
  if (_categoryChart) {
    _categoryChart.destroy();
    _categoryChart = null;
  }

  _categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: categories.map(c => c.category),
      datasets: [{
        data: categories.map(c => Number(c.totalValue || 0)),
        backgroundColor: generateColors(categories.length),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${fmtMoney(ctx.parsed)}`
          },
        },
      },
    },
  });
}

function generateColors(count) {
  const base = [
    "#74b9ff", "#55efc4", "#ffeaa7", "#fab1a0", "#a29bfe",
    "#fd79a8", "#81ecec", "#e17055", "#00cec9", "#fdcb6e"
  ];
  const colors = [];
  for (let i = 0; i < count; i++) colors.push(base[i % base.length]);
  return colors;
}

/** =================== Navigation =================== */
function setupNavigation() {
  document.getElementById("logout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });

  document.getElementById("logout-mobile")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });

  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    document.getElementById("mobile-menu")?.classList.toggle("show");
  });

  if (typeof lucide !== "undefined") {
    lucide.createIcons();
  }
}

/** =================== Init =================== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForSupabaseReady(); // ✅ ensures window.supabase exists + init finished
  } catch (e) {
    console.error("❌ Supabase failed to initialize:", e);
    // Optional: redirect to login or show an error banner
    return;
  }

  const allowed = await checkAuth();
  if (!allowed) return;

  setActiveNavLink();

  const pill = document.getElementById("pill-date");
  if (pill) {
    const d = new Date();
    const nice = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
    pill.innerHTML = `Date: <b>${nice}</b>`;
  }

  setupNavigation();

  const items = await loadInventoryData();
  const summary = computeSummaryByCategory(items);

  renderMetricCards(summary);
  renderCategoryTable(summary);
  renderCategoryChart(summary);
});

