// Add Inventory Item
document.getElementById('add-item-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
  
    const title = document.getElementById('title').value;
    const description = document.getElementById('description').value;
    const price = parseFloat(document.getElementById('price').value);
    const fileInput = document.getElementById('image');
    const file = fileInput.files[0];
  
    if (!file) return alert('Please upload an image.');
  
    const { data: { user } } = await supabase.auth.getUser();
    const filePath = `${user.id}/${Date.now()}_${file.name}`;
  
    const { error: uploadError } = await supabase.storage
      .from('merchandise')
      .upload(filePath, file);
  
    if (uploadError) return alert('Image upload failed.');
  
    const { data: { publicUrl } } = supabase.storage
      .from('merchandise')
      .getPublicUrl(filePath);
  
    const { error } = await supabase
      .from('inventory')
      .insert([{ user_id: user.id, title, description, price, image_url: publicUrl }]);
  
    if (error) {
      alert('Failed to add item.');
    } else {
      alert('Item added!');
      window.location.href = 'dashboard.html';
    }
  });
  
  // Show Inventory
  (async () => {
    const list = document.getElementById('inventory-list');
    if (!list) return;
  
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from('inventory')
      .select('*')
      .eq('user_id', user.id);
  
    if (error) {
      list.innerHTML = '<p>Failed to load inventory.</p>';
      return;
    }
  
    list.innerHTML = data.map(item => `
      <div>
        <img src="${item.image_url}" alt="${item.title}" />
        <h2>${item.title}</h2>
        <p>${item.description}</p>
        <p class="text-gold font-bold mt-2">$${item.price.toFixed(2)}</p>
      </div>
    `).join('');
  })();
  