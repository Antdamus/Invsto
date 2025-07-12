
/** Check if user is authenticated */
async function checkAuth() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = "index.html";
  } else {
    document.getElementById("admin-greeting").textContent = `Welcome, Admin`;
  }
}

/** Load inventory data by joining item_types and item_stock_locations */
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
    if (quantity > 0) {
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

/** Group and summarize by category */
function computeSummaryByCategory(items) {
  const summary = {
    totalItems: 0,
    totalCost: 0,
    totalValue: 0,
    categories: {},
  };

  for (const item of items) {
    const { category, quantity, totalCost, totalValue } = item;
    summary.totalItems += quantity;
    summary.totalCost += totalCost;
    summary.totalValue += totalValue;

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

  return summary;
}

/** Render metric cards at top */
function renderMetricCards(summary) {
  const container = document.getElementById("metric-cards");
  container.innerHTML = `
    <div class="metric-card">💰 Total Value: $${summary.totalValue.toLocaleString()}</div>
    <div class="metric-card">📦 Total Items: ${summary.totalItems}</div>
    <div class="metric-card">🧾 Total Cost: $${summary.totalCost.toLocaleString()}</div>
    <div class="metric-card">📈 Avg Markup: ${summary.totalCost ? (summary.totalValue / summary.totalCost).toFixed(2) : '—'}x</div>
  `;
}

/** Render detailed category breakdown table */
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

/** Render category breakdown pie chart */
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

/** Generate pastel color palette */
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

/** Logout handler */
document.getElementById('logout')?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
});

document.addEventListener("DOMContentLoaded", async () => {
  await checkAuth();
  const items = await loadInventoryData();
  const summary = computeSummaryByCategory(items);
  renderMetricCards(summary);
  renderCategoryTable(summary);
  renderCategoryChart(summary);
});
