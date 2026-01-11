/** =================== Auth (Admin Only) =================== */
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

/** =================== Data Loading =================== */
async function loadInventoryData() {
  let allItems = [];

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
  for (const stock of stockData) {
    if (!quantityMap[stock.item_id]) quantityMap[stock.item_id] = 0;
    quantityMap[stock.item_id] += stock.quantity;
  }

  for (const item of itemTypes) {
    const quantity = quantityMap[item.id] || 0;
    if (quantity > 0 && (!Array.isArray(item.categories) || !item.categories.includes("testcard"))) {
      allItems.push({
        ...item,
        quantity,
        totalCost: item.cost * quantity,
        totalValue: item.sale_price * quantity,
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

  for (const item of items) {
    const { categories, quantity, totalCost, totalValue } = item;
    const categoryList = Array.isArray(categories) ? categories : [];
    if (categoryList.includes("testcard")) continue;

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
  container.innerHTML = `
    <div class="metric-card">💰 Total Value: $${summary.totalValue.toLocaleString()}</div>
    <div class="metric-card">📦 Total Items: ${summary.totalItems}</div>
    <div class="metric-card">🧾 Total Cost: $${summary.totalCost.toLocaleString()}</div>
    <div class="metric-card">📈 Avg Markup: ${summary.totalCost ? (summary.totalValue / summary.totalCost).toFixed(2) : '—'}x</div>
  `;
}

function renderCategoryTable(summary) {
  const tableContainer = document.getElementById("inventory-table-container");
  const categories = Object.values(summary.categories);

  const rows = categories.map(cat => `
    <tr>
      <td>${cat.category}</td>
      <td>${cat.quantity}</td>
      <td>$${cat.totalCost.toLocaleString()}</td>
      <td>$${cat.totalValue.toLocaleString()}</td>
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

function renderCategoryChart(summary) {
  const categories = Object.values(summary.categories);
  const ctx = document.getElementById("category-chart").getContext("2d");

  new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: categories.map(c => c.category),
      datasets: [{
        data: categories.map(c => c.totalValue),
        backgroundColor: generateColors(categories.length),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = ctx.parsed;
              return `${ctx.label}: $${val.toLocaleString()}`;
            },
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
  for (let i = 0; i < count; i++) {
    colors.push(base[i % base.length]);
  }
  return colors;
}

/** =================== Navigation =================== */
function setupNavigation() {
  document.getElementById('logout')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  });

  document.getElementById('logout-mobile')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  });

  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    document.getElementById("mobile-menu")?.classList.toggle("show");
  });

  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

/** =================== Init =================== */
document.addEventListener("DOMContentLoaded", async () => {
  const allowed = await checkAuth();
  if (!allowed) return;

  setupNavigation();
  const items = await loadInventoryData();
  const summary = computeSummaryByCategory(items);
  renderMetricCards(summary);
  renderCategoryTable(summary);
  renderCategoryChart(summary);
});
