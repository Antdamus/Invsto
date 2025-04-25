//#region Full logic to get an item from supabase and get the barcode
    //function to extract item from supabase if it match barcode item
    async function ExtractItemWithBarcodeFromSupabase(inputElement, table = "stock", column = "barcode") {
        const value = inputElement.value.trim();
        if (!value) return;
      
        try {
          const { data, error } = await supabase
            .from(table)
            .select("*")
            .eq(column, value)
            .single();
      
          if (error || !data) {
            showToast("Item not found.", "error");
            console.warn("Supabase Error:", error);
            return null;
          }
      
          console.log("Item retrieved from Supabase:", data);
          return data;
        } catch (err) {
          console.error("Unexpected error:", err);
          showToast("Error fetching item.", "error");
          return null;
        }
    }

    //function to coordinate the rendering the item that has the required barcode
    
      
    //listener for the barcode
    (function searchForBarcodeListener() {
        const input = document.getElementById("input-to-search-inventory-item");
        let debounceTimer = null;
      
        input.addEventListener("input", () => {
          clearTimeout(debounceTimer);
      
          debounceTimer = setTimeout(() => {
            ExtractItemWithBarcodeFromSupabase({
                inputElement: input,
                table: "item_types",
                column: "barcode"
            });
          }, 1000); // Waits 1 second after typing ends
        });
    })();
      
  