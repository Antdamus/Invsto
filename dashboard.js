document.getElementById('logout')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  });
  
  (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      window.location.href = 'index.html';
    } else {
      document.getElementById('admin-greeting').textContent = `Welcome, Admin`;
  
      // Example data - replace with actual Supabase query
      const items = [
        { title: 'Diamond Ring', price: 4500 },
        { title: 'Gold Pendant', price: 2300 }
      ];
  
      // Render inventory table
      const table = document.createElement('table');
      table.classList.add('table');
  
      table.innerHTML = `
        <thead><tr><th>Title</th><th>Price ($)</th></tr></thead>
        <tbody>
          ${items.map(item => `<tr><td>${item.title}</td><td>${item.price.toLocaleString()}</td></tr>`).join('')}
        </tbody>
      `;
  
      document.getElementById('inventory-table-container').appendChild(table);
  
      // Render metric cards
      const cardContainer = document.getElementById('metric-cards');
      cardContainer.innerHTML = `
        <div class="card" style="padding: 1rem; background: white; border-radius: 10px; flex: 1;">
          <strong>Total Items:</strong> ${items.length}
        </div>
        <div class="card" style="padding: 1rem; background: white; border-radius: 10px; flex: 1;">
          <strong>Total Value:</strong> $${items.reduce((sum, i) => sum + i.price, 0).toLocaleString()}
        </div>
      `;
    }
  })();
  