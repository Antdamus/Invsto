
let pendingItem = null; // Store the scanned item awaiting confirmation
let currentBatch = {}; 
let latestLocationDymoXml = null;
let latestLocationDymoUrl = null;

//#region full logic to what will be done once the item reaches its limit
  //function to turn on and off the autofocus and the input of adding items by barcode
  function updateBarcodeInputStateBasedOnModals() {
    const barcodeInput = document.getElementById("input-to-search-inventory-item");
    const anyModalOpen = Array.from(document.querySelectorAll(".modal"))
      .some(modal => !modal.classList.contains("hidden"));
  
    // Prevent background scroll
    if (anyModalOpen) {
      document.body.classList.add("modal-open");
    } else {
      document.body.classList.remove("modal-open");
    }
  
    barcodeInput.disabled = anyModalOpen;
    if (!anyModalOpen) {
      barcodeInput.focus();
    }
  }

  //fetch unique location barcode
  async function fetchUniqueLocationBarcodes() {
    const { data, error } = await supabase
      .from("locations")
      .select("location_code")
      .neq("location_code", null);
  
    if (error) {
      console.error("❌ Failed to fetch location barcodes:", error);
      return [];
    }
  
    const uniqueCodes = [...new Set(data.map(row => row.location_code).filter(Boolean))];
    return uniqueCodes.sort((a, b) => a.localeCompare(b));
  }  
  
  //function to fetch the unique location types from the lcoation tables 
  async function fetchUniqueLocationTypes() {
    const { data, error } = await supabase
      .from("locations")
      .select("type")
      .neq("type", null);
  
    if (error) {
      console.error("❌ Failed to fetch location types:", error);
      return [];
    }
  
    const uniqueTypes = [...new Set(data.map(row => row.type).filter(Boolean))];
    return uniqueTypes.sort((a, b) => a.localeCompare(b));
  }
  
  // ✅ Updated to pull from the `locations` table
  async function fetchUniqueLocationNames() {
    const { data, error } = await supabase
      .from("locations")
      .select("location_name")
      .eq("active", true); // optional: only include active locations

    if (error || !data) {
      console.error("❌ Failed to fetch location names from `locations`:", error);
      return [];
    }

    const unique = [...new Set(data.map(row => row.location_name).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b)); // alphabetical
  }

  //function to transform the inputs into selected in case it is needed
  function syncHiddenInputsWithDropdowns() {
    const form = document.getElementById("filter-form");
    if (!form) return; // 🛑 Prevent crashing if filter-form is not present
    //const telecooll = new FormData(form);
    //console.log("🧾 Form Values from inside synchhindder:", telecooll.getAll("categories"))

    // 🔍 Log current state before clearing
    //console.log("🧹 Before clearing: categories =", [...form.querySelectorAll('input[name="categories"]')].map(i => i.value));
  
    // 🔁 Clear previous category inputs
    form.querySelectorAll('input[name="categories"]').forEach(el => el.remove());
    form.querySelectorAll('input[name="qr_type"]').forEach(el => el.remove());

    //let catInputCounter = 0;
  
    // ✅ Add back categories from selected dropdowns
    document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el => {
      //catInputCounter++;
      //console.log(`📌 Hidden category input #${catInputCounter}: ${el.dataset.cat}`);
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "categories";
      input.value = el.dataset.cat;
      form.appendChild(input);
    });
    //catInputCounter = 0;
    // ✅ Add back QR types from selected dropdowns
    document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "qr_type";
      input.value = el.dataset.qr;
      form.appendChild(input);
    });
  
    // ✅ Log final result
    //console.log("✅ After sync: categories =", [...form.querySelectorAll('input[name="categories"]')].map(i => i.value));
  }
    
  /** Function that will create the html block for the drop down, insert search bar, attach listener
 * Renders a searchable dropdown and lets the caller define behavior
 * for selecting existing options or creating new ones.
 * @param {Object} config
 * @param {string} config.menuId - ID of the DOM container
 * @param {Array<string>} config.options - Array of string values to display
 * @param {string} [config.searchId="category-search"] - Search input ID
 * @param {string} [config.placeholder="Search..."] - Input placeholder text
 * @param {string} [config.optionClass="dropdown-option"] - Class for each option div
 * @param {string} [config.dataAttribute="cat"] - The data-* attribute key (e.g. "cat", "qr")
 * @param {string} [config.optionsContainerClass="dropdown-options-container"]
 * @param {Function} config.onClick - What to do when any option is clicked (new or existing)
 */
  function renderDropdownOptionsCustom({
    menuId,
    options = [],
    searchId = "category-search",
    placeholder = "Search...",
    optionClass = "dropdown-option",
    dataAttribute = "cat",
    optionsContainerClass = "dropdown-options-container",
    onClick,  // 🔥 REQUIRED: handler for both new and existing options
    showHTMLInjected = true // 🆕 Optional debug flag
  }) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
  
    const searchHTML = `
      <div class="dropdown-search-container">
        <input type="text" id="${searchId}" class="dropdown-search" placeholder="${placeholder}">
      </div>
    `;
  
    const optionsHTML = `
      <div class="${optionsContainerClass}">
        ${options.map(opt => `
          <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
        `).join("")}
      </div>
    `;
  
    const fullHTML = searchHTML + optionsHTML;
  
    if (showHTMLInjected) {
      console.log("🧪 [renderDropdownOptionsCustom] Injected HTML for", menuId);
      console.log(fullHTML);
      debugger;
    }
  
    menu.innerHTML = fullHTML;
  
    const input = menu.querySelector(`#${searchId}`);
    const container = menu.querySelector(`.${optionsContainerClass}`);
  
    const attachClickHandlers = () => {
      container.querySelectorAll(`.${optionClass}[data-${dataAttribute}]`).forEach(optionEl => {
        optionEl.addEventListener("click", () => {
          const value = optionEl.dataset.value;
          const isNew = optionEl.dataset.new === "true";
          syncHiddenInputsWithDropdowns();
          if (typeof onClick === "function") {
            onClick(value, isNew, optionEl);
          }
        });
      });
    };
  
    attachClickHandlers();
  
    input.addEventListener("input", (e) => {
      const search = e.target.value.toLowerCase();
      const filtered = options.filter(opt =>
        opt.toLowerCase().includes(search)
      );
  
      let html = filtered.map(opt => `
        <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
      `).join("");
  
      const exactMatch = options.some(opt => opt.toLowerCase() === search);
  
      if (search && !exactMatch) {
        html += `
          <div class="${optionClass} new-entry" data-${dataAttribute}="${search}" data-value="${search}" data-new="true">
            ➕ Create "${search}"
          </div>
        `;
      }
  
      container.innerHTML = html;
      attachClickHandlers();
    });
  }
  
  //function to populate the dropdown 
  async function populateLocationDropdown() {
    const options = await fetchUniqueLocationNames();
    renderDropdownOptionsCustom({
      menuId: "location-dropdown-list",
      options,
      searchId: "location-dropdown-search", // ✅ you'll add this ID to the search input
      placeholder: "Search or select location...",
      optionClass: "location-option",         // CSS class for styling
      dataAttribute: "location",              // Used for dataset.location
      optionsContainerClass: "location-options-container", // for styling
      onClick: (value, isNew, el) => {
        if (isNew) {
          document.getElementById("location-name").value = value;
          toggleModal(true); // 🔁 Use this instead of manual classList.remove
          return;
        }
      
        document.getElementById("location-dropdown-search").value = value;
        showToast(`📦 Location selected: ${value}`);
      }
    });
  }

  //function to show the modal for add location 
  // 🪄 Open/close modal with optional barcode generation
  function toggleModal(show = true) {
    const modal = document.getElementById("modal-add-location");
    const nameInput = document.getElementById("location-name");
  
    if (show) {
      modal.classList.remove("hidden");
      updateBarcodeInputStateBasedOnModals();
      nameInput.focus();
      generateAndRenderLocationBarcode();
    } else {
      modal.classList.add("hidden");
      updateBarcodeInputStateBasedOnModals();
      clearForm();
    }
  }
  
  
  //function to coordinate the display of the assign location modal 
  function showAssignLocationModal(batchItem) {
    const modal = document.getElementById("modal-assign-location");
    const lastUsedLabel = document.getElementById("last-used-location-name");
  
    // Show last used location if any
    const lastLocation = batchItem.lastLocation || "—";
    lastUsedLabel.textContent = lastLocation;
  
    modal.dataset.barcode = batchItem.item.barcode;
    modal.classList.remove("hidden");
  
    updateBarcodeInputStateBasedOnModals();
  
    populateLocationDropdown(); // this injects search field
  
    // Delay the focus until dropdown search is actually injected
    setTimeout(() => {
      const searchInput = document.getElementById("assign-location-name-search");
      if (searchInput) searchInput.value = ""; // clear previous
      searchInput?.focus();
    }, 100); // small delay to wait for DOM update
  }
  
  //function to coordinate the display of the limit modal
  function showBatchThresholdModal(batchItem) {
    const modal = document.getElementById("modal-batch-threshold-reached");
    const scannedCountDisplay = document.getElementById("scanned-count-display");
    const inputField = document.getElementById("input-manual-count");
    const errorMsg = document.getElementById("manual-count-error-msg");
    const input = document.getElementById("input-to-search-inventory-item");
  
    // 🧠 NEW: populate photo and title in the modal
    const item = batchItem.item;
    const itemPhotoEl = document.getElementById("batch-item-photo");
    const itemTitleEl = document.getElementById("batch-item-title");
  
    itemPhotoEl.src = item.photos?.[0] || "";
    itemPhotoEl.alt = item.title || "Item Photo";
    itemTitleEl.textContent = item.title || "Unnamed Item";
  
    modal.dataset.barcode = item.barcode;
    scannedCountDisplay.textContent = batchItem.count;
    inputField.value = "";
    errorMsg.classList.add("hidden");
    updateBarcodeInputStateBasedOnModals();
  
    modal.classList.remove("hidden");
    updateBarcodeInputStateBasedOnModals();
    inputField.focus();
  }

  //listeners
    //manual countverification listener
    function setupManualCountVerificationListeners() {
      const modal = document.getElementById("modal-batch-threshold-reached");
      const confirmBtn = document.getElementById("btn-confirm-manual-count");
      const cancelBtn = document.getElementById("btn-cancel-manual-count");
      const input = document.getElementById("input-manual-count");
      const errorMsg = document.getElementById("manual-count-error-msg");
      const inputScanner = document.getElementById("input-to-search-inventory-item");
    
      confirmBtn.onclick = () => {
        const barcode = modal.dataset.barcode;
        const batchItem = currentBatch[barcode];
        const manualCount = parseInt(input.value.trim(), 10);
    
        if (isNaN(manualCount)) return;
    
        if (manualCount === batchItem.count) {
          showToast("✅ Manual count confirmed. Please assign location.");
          modal.classList.add("hidden");
          errorMsg.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          inputScanner.disabled = false;
          inputScanner.blur();
    
          showAssignLocationModal(batchItem); // 👈 trigger next modal
        } else {
          errorMsg.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();

          const mismatchModal = document.getElementById("modal-manual-count-mismatch");
          mismatchModal.dataset.barcode = barcode;
          modal.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          mismatchModal.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();

        }
      };
    
      cancelBtn.onclick = () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        errorMsg.classList.add("hidden");
        inputScanner.disabled = false;
        inputScanner.focus();
      };
    }

    //missmatch in count listener 
    function setupMismatchResetModalListener() {
      const modal = document.getElementById("modal-manual-count-mismatch");
      const okButton = document.getElementById("btn-reset-count-to-zero");
      const scannerInput = document.getElementById("input-to-search-inventory-item");
    
      okButton.onclick = () => {
        const barcode = modal.dataset.barcode;
        if (!barcode || !currentBatch[barcode]) return;
      
        const batchItem = currentBatch[barcode];
        batchItem.count = 0;
      
        // Reset UI counter
        const unitDisplay = batchItem.cardEl.querySelector(".units-scanned");
        if (unitDisplay) {
          unitDisplay.textContent = `Units Scanned: 0`;
        }
      
        // 🔴 Add red glow class
        batchItem.cardEl.classList.add("count-zero-alert");
      
        // Hide the modal and refocus scanner
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        scannerInput.disabled = false;
        scannerInput.focus();
      };
      
    }

    //event listener for assigning the location to item 
    function setupAssignLocationModalListeners() {
      const modal = document.getElementById("modal-assign-location");
      const confirmBtn = document.getElementById("btn-confirm-location-assign");
      const cancelBtn = document.getElementById("btn-cancel-location-assign");
      const searchInput = document.getElementById("location-dropdown-search");
      const scanInput = document.getElementById("input-scan-location-barcode");
      const barcodeInput = document.getElementById("input-to-search-inventory-item");
    
      cancelBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        barcodeInput.disabled = false;
        barcodeInput.focus();
      });
    
      confirmBtn.addEventListener("click", async () => {
        const barcode = modal.dataset.barcode;
        const batchItem = currentBatch[barcode];
        const location_name = document.getElementById("assign-location-name").value.trim();
        const location_code = document.getElementById("assign-location-barcode").value.trim();
      
        if (!location_name && !location_code) {
          showToast("⚠️ Please select a location name or barcode.");
          return;
        }
      
        const { data: locationData, error } = await supabase
          .from("locations")
          .select("id")
          .or(`location_name.eq.${location_name},location_code.eq.${location_code}`)
          .single();
      
        if (error || !locationData) {
          showToast("❌ Could not find matching location.");
          return;
        }
      
        // ✅ Trigger password modal
        window.showPasswordConfirmModal(batchItem, locationData.id, location_name || location_code);
      });      
    }
    
    //#region 🔧 Location Modal Logic
    function setupLocationModalListeners() {
      const modal = document.getElementById("modal-add-location");
      const form = document.getElementById("form-add-location");
      const cancelBtn = document.getElementById("btn-cancel-location");
    
      const nameInput = document.getElementById("location-name");
      const barcodeInput = document.getElementById("location-barcode");
      const capacityInput = document.getElementById("location-capacity");
      const photoInput = document.getElementById("location-photo");
      const previewWrapper = document.getElementById("photo-preview-wrapper");
      const previewImage = document.getElementById("photo-preview-image");

      photoInput.addEventListener("change", () => {
        const file = photoInput.files?.[0];
        if (!file) {
          previewWrapper.classList.add("hidden");
          previewImage.src = "";
          return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
          previewImage.src = e.target.result;
          previewWrapper.classList.remove("hidden");
        };
        reader.readAsDataURL(file);
      });

      const notesInput = document.getElementById("location-notes");
      const generateBtn = document.getElementById("btn-generate-location-barcode");
    
      // 🔁 Shared barcode generator
      function generateAndRenderLocationBarcode() {
        const generatedCode = `LOC-${Date.now().toString().slice(-6)}`;
        JsBarcode("#barcode-canvas-location", generatedCode, {
          format: "CODE128",
          displayValue: true,
          fontSize: 16,
          height: 60
        });
        barcodeInput.value = generatedCode;
      
        // ⬇️ Generate DYMO XML for location (only barcode)
        latestLocationDymoXml = `<?xml version="1.0" encoding="utf-8"?>
        <DesktopLabel Version="1">
          <DYMOLabel Version="4">
            <Description>DYMO Label</Description>
            <Orientation>Landscape</Orientation>
            <LabelName>Small30346</LabelName>
            <InitialLength>0</InitialLength>
            <BorderStyle>SolidLine</BorderStyle>
            <DYMORect>
              <DYMOPoint>
                <X>0.22666666</X>
                <Y>0.056666665</Y>
              </DYMOPoint>
              <Size>
                <Width>1.59</Width>
                <Height>0.4033333</Height>
              </Size>
            </DYMORect>
            <BorderColor>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderColor>
            <BorderThickness>1</BorderThickness>
            <Show_Border>False</Show_Border>
            <HasFixedLength>False</HasFixedLength>
            <FixedLengthValue>0</FixedLengthValue>
            <DynamicLayoutManager>
              <RotationBehavior>ClearObjects</RotationBehavior>
              <LabelObjects>
                <BarcodeObject>
                  <Name>BarcodeObject0</Name>
                  <Brushes>
                    <BackgroundBrush>
                      <SolidColorBrush>
                        <Color A="1" R="1" G="1" B="1"></Color>
                      </SolidColorBrush>
                    </BackgroundBrush>
                    <BorderBrush>
                      <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                      </SolidColorBrush>
                    </BorderBrush>
                    <StrokeBrush>
                      <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                      </SolidColorBrush>
                    </StrokeBrush>
                    <FillBrush>
                      <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                      </SolidColorBrush>
                    </FillBrush>
                  </Brushes>
                  <Rotation>Rotation0</Rotation>
                  <OutlineThickness>1</OutlineThickness>
                  <IsOutlined>False</IsOutlined>
                  <BorderStyle>SolidLine</BorderStyle>
                  <Margin>
                    <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
                  </Margin>
                  <BarcodeFormat>Code128Auto</BarcodeFormat>
                  <Data>
                    <DataString>${generatedCode}</DataString>
                  </Data>
                  <HorizontalAlignment>Center</HorizontalAlignment>
                  <VerticalAlignment>Middle</VerticalAlignment>
                  <Size>AutoFit</Size>
                  <TextPosition>Bottom</TextPosition>
                  <FontInfo>
                    <FontName>Arial</FontName>
                    <FontSize>8</FontSize>
                    <IsBold>False</IsBold>
                    <IsItalic>False</IsItalic>
                    <IsUnderline>False</IsUnderline>
                    <FontBrush>
                      <SolidColorBrush>
                        <Color A="1" R="0" G="0" B="0"></Color>
                      </SolidColorBrush>
                    </FontBrush>
                  </FontInfo>
                  <ObjectLayout>
                    <DYMOPoint>
                      <X>0.22666667</X>
                      <Y>0.06666668</Y>
                    </DYMOPoint>
                    <Size>
                      <Width>1.3885133</Width>
                      <Height>0.39078796</Height>
                    </Size>
                  </ObjectLayout>
                </BarcodeObject>
              </LabelObjects>
            </DynamicLayoutManager>
          </DYMOLabel>
          <LabelApplication>Blank</LabelApplication>
          <DataTable>
            <Columns></Columns>
            <Rows></Rows>
          </DataTable>
        </DesktopLabel>`;

        // Immediately upload DYMO file and show link
        (async () => {
          const labelPath = `labels/location_${Date.now()}.dymo`;
          const blob = new Blob([latestLocationDymoXml], { type: "application/octet-stream" });

          const { error: uploadError } = await supabase.storage
            .from("dymo-labels")
            .upload(labelPath, blob, { upsert: true });

          if (uploadError) {
            console.error("❌ Failed to upload DYMO file early:", uploadError);
            return;
          }

          const { data: signedData, error: urlError } = await supabase.storage
            .from("dymo-labels")
            .createSignedUrl(labelPath, 60 * 60 * 24 * 365 * 10); // 10 years

          if (urlError) {
            console.error("❌ Failed to get signed URL for DYMO file:", urlError);
            return;
          }

          latestLocationDymoUrl = signedData.signedUrl;

          // Inject the link into the modal
          const linkContainer = document.getElementById("dymo-link-preview");
          if (linkContainer) {
            linkContainer.innerHTML = `<a href="${latestLocationDymoUrl}" target="_blank">📎 View DYMO Label</a>`;
          }
        })();


      }
      
      //lazy dropdown creation
      let activeDropdown = null;
      document.addEventListener("click", async (e) => {
        const isToggle = e.target.id === "location-type-dropdown-toggle";
        if (!isToggle) return;

        const button = e.target;
        const menu = document.getElementById("location-type-dropdown-menu");

        // 🧹 Close any other dropdowns
        if (activeDropdown && activeDropdown !== menu) {
          activeDropdown.classList.remove("show");
        }

        // 🧠 Populate only once
        if (!menu.dataset.populated) {
          const types = await fetchUniqueLocationTypes();
          renderDropdownOptionsCustom({
            menuId: "location-type-dropdown-menu",
            options: types,
            searchId: "location-type-search",
            placeholder: "Search or create location type...",
            optionClass: "dropdown-option",
            dataAttribute: "type",
            optionsContainerClass: "location-type-dropdown-container",
            onClick: (value, isNew, el) => {
              document.getElementById("location-type").value = value;
              button.innerText = value;
              showToast(isNew ? `➕ Created new type: ${value}` : `🏷️ Selected type: ${value}`);
              menu.classList.remove("show");
              activeDropdown = null;
            }
          });
          menu.dataset.populated = "true";
        }

        // 👁️ Toggle visibility
        menu.classList.toggle("show");
        activeDropdown = menu.classList.contains("show") ? menu : null;
      });

      
      // Clear form fields
      function clearForm() {
        nameInput.value = "";
        barcodeInput.value = "";
        capacityInput.value = "";
        notesInput.value = "";
        photoInput.value = "";
        // Optionally clear canvas too:
        const canvas = document.getElementById("barcode-canvas-location");
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const typeBtn = document.getElementById("location-type-dropdown-toggle");
        const typeMenu = document.getElementById("location-type-dropdown-menu");
        document.getElementById("location-type").value = "";
        typeBtn.innerText = "Select Location Type";
        typeMenu.dataset.populated = "";
        typeMenu.innerHTML = ""; // fully reset menu

      }
    
      // 🧲 Generate on button click
      generateBtn.addEventListener("click", generateAndRenderLocationBarcode);
    
      cancelBtn.addEventListener("click", () => toggleModal(false));
    
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
    
        const location_name = nameInput.value.trim();
        const location_code = barcodeInput.value.trim();
        const max_capacity = capacityInput.value.trim();
        const notes = notesInput.value.trim();
        const photoFile = photoInput.files?.[0] || null;
    
        if (!location_name || !location_code) {
          showToast("⚠️ Name and barcode are required.");
          return;
        }
    
        showToast("Uploading...");
    
        let photo_url = null;
        let dymo_label_url = null;

        if (latestLocationDymoXml) {
          const labelPath = `labels/location_${Date.now()}.dymo`;
          const blob = new Blob([latestLocationDymoXml], { type: "application/octet-stream" });

          const { error: uploadError } = await supabase.storage
            .from("dymo-labels")
            .upload(labelPath, blob, { upsert: true });

          if (!uploadError) {
            const { data: signedData, error: urlError } = await supabase.storage
              .from("dymo-labels")
              .createSignedUrl(labelPath, 60 * 60 * 24 * 365 * 10); // 10 years

            if (!urlError) {
              dymo_label_url = signedData.signedUrl;
            }
          }
        }

        if (photoFile) {
          const { data, error } = await supabase.storage
          .from("location-assets")
          .upload(`photos/${Date.now()}_${photoFile.name}`, photoFile);

        if (error) {
          showToast("❌ Failed to upload photo.");
          return;
        }
          const { data: urlData } = supabase.storage.from("location-assets").getPublicUrl(data.path);
          photo_url = urlData.publicUrl;
          photo_path = data.path; // ⬅️ New
        }
    
        const { error: insertError } = await supabase.from("locations").insert({
          location_name,
          location_code,
          max_capacity: max_capacity ? parseInt(max_capacity) : null,
          notes,
          active: true,
          photo_url,
          dymo_label_url,
          type: document.getElementById("location-type").value || null,
          created_at: new Date().toISOString()
        });
    
        if (insertError) {
          console.error("❌ Error inserting location:", insertError);
          showToast("❌ Failed to save location.");
          return;
        }
    
        showToast("✅ Location saved!");
        toggleModal(false);
        await populateLocationDropdown();
      });

    }

    //event listener to have a confirmation of who added the batch 
    function setupPasswordConfirmationModal() {
      const modal = document.getElementById("modal-password-confirm");
      const emailInput = document.getElementById("password-confirm-email");
      const passwordInput = document.getElementById("password-confirm-password");
      const errorMsg = document.getElementById("password-confirm-error");
      const confirmBtn = document.getElementById("btn-confirm-password");
      const cancelBtn = document.getElementById("btn-cancel-password");
    
      let pendingAssignment = null; // { batchItem, location_id, location_name }
    
      // 👇 Called from assign-location modal
      window.showPasswordConfirmModal = (batchItem, location_id, location_name) => {
        pendingAssignment = { batchItem, location_id, location_name };
        emailInput.value = currentUser.email || "";
        passwordInput.value = "";
        errorMsg.style.display = "none";
        modal.classList.remove("hidden");
        updateBarcodeInputStateBasedOnModals();
        passwordInput.focus();
      };
    
      confirmBtn.onclick = async () => {
        const password = passwordInput.value.trim();
        if (!password) return;
    
        const { data, error } = await supabase.auth.signInWithPassword({
          email: currentUser.email,
          password: password,
        });
    
        if (error || !data.session) {
          errorMsg.style.display = "block";
          return;
        }
    
        // ✅ Password valid — insert
        const { batchItem, location_id, location_name } = pendingAssignment;
    
        const { error: insertError } = await supabase.from("item_stock_locations").insert({
          item_id: batchItem.item.id,
          location_id,
          quantity: batchItem.count,
          added_by: currentUser.id,
          confirmation_email: currentUser.email,
          confirmation_method: "manual_password",
          confirmed_at: new Date().toISOString(),
        });
    
        if (insertError) {
          console.error("❌ Failed to insert:", insertError);
          showToast("❌ Failed to save stock assignment.");
          return;
        }
    
        showToast(`✅ Saved ${batchItem.count} to ${location_name}`);
        modal.classList.add("hidden");
        document.getElementById("modal-assign-location").classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        document.getElementById("input-to-search-inventory-item").focus();
      };
    
      cancelBtn.onclick = () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        document.getElementById("input-to-search-inventory-item").focus();
      };
    }
    
    
//#endregion

    
  

//#endregion 

//#region Full logic to get an item from supabase and get the barcode
    //show toast function
    function showToast(message) {
        const container = document.getElementById("toast-container"); // Target container
        //-> you are accessing the div id= toast container node in the DOM (document object model)
        const toast = document.createElement("div"); //this is creating a new div element
        //-> in memory, not in the DOM per se, just a standalone javascript object for now
        //remember the div is just a box
        //and in here toast is not an html id, rather is just a varible holding the pointer to the
        //the object
        toast.className = "toast"; //it just gave the div you created called toast a class name
        toast.textContent = message; //injects the message into the container
        //<div class="toast">Item added!</div>
        container.appendChild(toast); //this is injecting the full javascript object into the 
        //node of the the DOM so now the user can see it live 
        // <div id="toast-container">
        //   <div class="toast">📦 Your toast message</div>
        // </div>
      
        // Remove toast after 4 seconds
        setTimeout(() => {
          toast.remove();
        }, 4000);
    }

    //function to extract item from supabase if it match barcode item
    async function ExtractItemWithBarcodeFromSupabase(barcode, table = "item_types", column = "barcode", debug = false) {
        try {
            const { data, error } = await supabase
                .from(table)
                .select("*")
                .eq(column, barcode)
                .single();
    
            if (debug) {
                console.log("🔍 [DEBUG] Barcode Query Result:");
                console.log(data);
            }
    
            if (error || !data) {
                if (debug) {
                    console.warn("⚠️ [DEBUG] Item not found or error occurred.", { error });
                }
                return null;
            }
    
            return data;
        } catch (err) {
            console.error("❌ [DEBUG] Unexpected error while querying Supabase:", err);
            showToast("Error contacting database.", "error");
            return null;
        }
    }

    //function to play sound after item is scanned
    function playScanSound() {
      const audio = document.getElementById("scan-sound");
      if (audio) audio.play();
    }
    
    //#region Rendering card item that matched barcode
        //#region buil image carousel
            //Move to next image in carousel for a given card
            function nextSlide({
              index,
              carouselTrackClass = "carousel-track",
              photoActualClass = "carousel-photo"
            }={}) {
                const carousel = document.getElementById(`carousel-${index}`);
                const track = carousel.querySelector(`.${carouselTrackClass}`);
                const images = track.querySelectorAll(`.${photoActualClass}`);
            
                // 🔍 Find currently active image
                const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
                images[currentIndex].classList.remove("active");
            
                // 🔁 Move to next image (wrap around)
                const nextIndex = (currentIndex + 1) % images.length;
                images[nextIndex].classList.add("active");
            } //needs event listener
            
            //Move to previous image in carousel for a given card
            function prevSlide({
              index,
              carouselTrackClass = "carousel-track",
              photoActualClass = "carousel-photo"
            }={}) {
                const carousel = document.getElementById(`carousel-${index}`);
                const track = carousel.querySelector(`.${carouselTrackClass}`);
                const images = track.querySelectorAll(`.${photoActualClass}`);
            
                const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
                images[currentIndex].classList.remove("active");
            
                // 🔁 Move to previous image (wrap around)
                const prevIndex = (currentIndex - 1 + images.length) % images.length;
                images[prevIndex].classList.add("active");
            } //needs event listener

            //carousel html block
            /**photos is going to be an array of photos URL 
            * Index is going to give you the position of the card in the main array
            * so you can see which carousel belongs to which item 
            */
            function buildCarousel({
                photos, 
                index,
                carouselContainerClass = "carousel",
                carouselBtnClass = "carousel-btn",
                iconOfNextCarouselButtonClass = "carousel-icon",
                carouselTrackClass = "carousel-track",
                photoActualClass = "carousel-photo"
            } = {}) {
            if (!photos.length) return `<div class="no-photo">No Photos</div>`;
            
            return `
                <div class="${carouselContainerClass}" id="carousel-${index}">
                    <button class="${carouselBtnClass} left" data-carousel-index="${index}" data-dir="prev">
                        <i data-lucide="chevron-left" class="${iconOfNextCarouselButtonClass}"></i>
                    </button>
                    <div class="${carouselTrackClass}">
                        ${photos.map((photo, i) => `
                        <img src="${photo}" class="${photoActualClass} ${i === 0 ? 'active' : ''}" />
                        `).join('')}
                    </div>
                    <button class="${carouselBtnClass} right" data-carousel-index="${index}" data-dir="next">
                        <i data-lucide="chevron-right" class="${iconOfNextCarouselButtonClass}"></i>
                    </button>
                </div>
            `;
           
            }    
        //#endregion
        
        //build the HTML of the card content
        function buildCardContent({
          item,
          chipCardDisplayClass = "category-chip",
          chipSectionTitleClass = "chip-section-label",
          chipContainerClass = "category-chips",
          cardContentOutsidePictureClass = "stock-content",
          hiddenFieldsCardContent = [],
          debug = false
        } = {}) {
          const stock = typeof item.stock === "number" ? item.stock : 0;
          const stockClass = stock === 0 ? "stock-zero" : "";
        
          const show = (field) => !hiddenFieldsCardContent.includes(field); // ✅ Clean utility
        
          const stockLabel = stock === 0
            ? `<p class="stock-count ${stockClass}">
                 <i data-lucide="alert-circle" class="stock-alert-icon"></i> In Stock: ${stock}
               </p>`
            : `<p class="stock-count">In Stock: ${stock}</p>`;
        
          const categoryChips = (item.categories || []).map(cat => `
            <div class="${chipCardDisplayClass}" data-cat="${cat}" data-id="${item.id}">
              ${cat}
            </div>
          `).join("");
        
          const html = `
            <div class="${cardContentOutsidePictureClass}">
              ${show("title") ? `<h2>${item.title}</h2>` : ""}
              ${show("description") ? `<p>${item.description}</p>` : ""}
              ${show("weight") ? `<p><strong>Weight:</strong> ${item.weight}</p>` : ""}
              ${show("cost") ? `<p><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>` : ""}
              ${show("sale_price") ? `<p><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>` : ""}
              ${show("barcode") ? `<p><strong>Barcode:</strong> ${item.barcode || "—"}</p>` : ""}
              ${show("created_at") ? `<p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>` : ""}
              ${show("dymo_label_url") ? `<p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>` : ""}
              ${show("stock") ? stockLabel : ""}
              ${show("units_scanned") ? `<p class="units-scanned"><strong>Units Scanned:</strong> 1</p>` : ""}
              ${show("categories") ? `
                <p class="${chipSectionTitleClass}">Categories:</p>
                <div class="${chipContainerClass}">
                  ${categoryChips}
                </div>
              ` : ""}
            </div>
          `;
        
          if (debug) {
            console.log("[DEBUG] Generated Card HTML for barcode:", item.barcode, html);
          }
        
          return html;
        }
              
        //function to coordinate the rendering of one single item
        function renderInventoryItem({
            item,
            index, 
            CardContainerClass = "stock-card", 
            ImageContainerClass = "stock-image-container", 
            Identifier = "id",
            chipOneCardDisplayClass = "category-chip",
            chipOneSectionTitleClass = "chip-section-label",
            chipOneContainerClass = "category-chips",
            cardOneContentOutsidePictureClass = "stock-content",
            carouselOneContainerClass = "carousel",
            carouselOneBtnClass = "carousel-btn",
            iconOneOfNextCarouselButtonClass = "carousel-icon",
            carouselOneTrackClass = "carousel-track",
            photoOneActualClass = "carousel-photo",
            hiddenOneFieldsCardContent = []
        } = {}) { 
            const card = document.createElement("div");
            card.className = CardContainerClass;
            card.style.position = "relative"; /**This will ensure all children inside
            this cards are positioned related to it */
            card.dataset.itemId = item[Identifier]; /** this is going to give to that card 
            object a specific id, which is going to be in the id column (key) of the item
            (row from data array)
            now the good thing is that this can be used by an event listener*/
        
            const photoCarousel = buildCarousel({
              photos: item.photos || [], 
              index: index,
              carouselContainerClass: carouselOneContainerClass,
              carouselBtnClass: carouselOneBtnClass,
              iconOfNextCarouselButtonClass: iconOneOfNextCarouselButtonClass,
              carouselTrackClass: carouselOneTrackClass,
              photoActualClass: photoOneActualClass

            });
            const content = buildCardContent({
                item: item,
                chipCardDisplayClass: chipOneCardDisplayClass,
                chipSectionTitleClass: chipOneSectionTitleClass,
                chipContainerClass: chipOneContainerClass,
                cardContentOutsidePictureClass: cardOneContentOutsidePictureClass,
                hiddenFieldsCardContent: hiddenOneFieldsCardContent
            });
        
            card.innerHTML = `
            <div class="${ImageContainerClass}">
                ${photoCarousel}
            </div>
            ${content}
            `;
        
            return card;
        }
    //#endregion

    //function to reset the batch once it is done
    function resetBatch() {
        currentBatch = {};
        document.getElementById("batch-items-container").innerHTML = "";
    }

    //function to coordinate card animation on update
    function animateCardUpdate(cardElement) {
      // Remove any animation classes in case they’re still there
      cardElement.classList.remove("updated", "updated-flip", "flash-border");
    
      // Force reflow to restart animation
      void cardElement.offsetWidth;
    
      // Re-add animation classes
      cardElement.classList.add("updated", "updated-flip", "flash-border");
    
      // Clean up after animation
      setTimeout(() => {
        cardElement.classList.remove("flash-border");
      }, 500);
    
      setTimeout(() => {
        cardElement.classList.remove("updated");
        // Optional: keep flip for more visual flair, or remove it here
        cardElement.classList.remove("updated-flip");
      }, 500);
    
      playScanSound();
    }
    
    //function necessary to increment the stock count once the card has been already created
    function incrementCardCount(barcode) {
      const batchItem = currentBatch[barcode];
    
      if (batchItem.count >= batchItem.maxCount) {
        showToast("🚫 This item has already reached its batch limit.");
        showBatchThresholdModal(batchItem); // 🔁 Re-trigger modal every time
        return;
      }
    
      batchItem.count++;

      // 🧼 Remove red glow if previously flagged
      batchItem.cardEl.classList.remove("count-zero-alert");
    
      const unitDisplay = batchItem.cardEl.querySelector(".units-scanned");
      if (unitDisplay) {
        unitDisplay.textContent = `Units Scanned: ${batchItem.count}`;
      }
    
      animateCardUpdate(batchItem.cardEl);
    
      if (batchItem.count >= batchItem.maxCount) {
        showBatchThresholdModal(batchItem); // 👈 Initial trigger
      }
    }
    
    //function to render the card and put into the DOM
    function createCardForItem(item, ContainerForCardInjection = "batch-items-container") {
        const batchContainer = document.getElementById(ContainerForCardInjection); // your target div
        const index = Object.keys(currentBatch).length; // for carousel IDs etc
        const card = renderInventoryItem({ 
        item, 
        index,
        hiddenOneFieldsCardContent: ["dymo_label_url", "description", "barcode", "cost", "created_at"] });
        
        // 🔍 Log the full preview card DOM element and item data
        console.log(" Card Element:", card);

        batchContainer.appendChild(card);
        lucide.createIcons();  

        return card;
    }
      
    //function that will be used to initialize the card for the first time
    function handleScannedItem(item) {
      const card = createCardForItem(item);
    
      currentBatch[item.barcode] = {
        item,
        count: 1,
        maxCount: item.stock_batch_size_update || 10, // 🔢 Use item's custom batch size or default to 10
        cardEl: card
      };
    }
    

    // Function to hide the confirmation modal
    function hideModalToConfirmItem() {
      const modal = document.getElementById("modalToConfirmItem");
      modal.classList.add("hidden"); // Hide the modal
      updateBarcodeInputStateBasedOnModals();
      pendingItem = null; // Clear pending item
    
      // 👉 Refocus barcode input after modal closes
      document.getElementById("input-to-search-inventory-item").focus();
    }

    //function to create listener for the popup to appear
    function setupModalToConfirmItemListeners() {
        const confirmButton = document.getElementById("confirmAddItemBtn");
        const cancelButton = document.getElementById("cancelAddItemBtn");
    
        confirmButton.addEventListener("click", () => {
        if (pendingItem) {
            handleScannedItem(pendingItem);
            pendingItem = null;
        }
        hideModalToConfirmItem();
        });
    
        cancelButton.addEventListener("click", () => {
        hideModalToConfirmItem();
        });
    
        // Optional: Press "Enter" to confirm automatically
        document.addEventListener("keydown", (e) => {
        const modal = document.getElementById("modalToConfirmItem");
        if (!modal.classList.contains("hidden")) {
            if (e.key === "Enter") {
            e.preventDefault();
            confirmButton.click();
            } else if (e.key === "Escape") {
            e.preventDefault();
            cancelButton.click();
            }
        }
        });
    }

    //coorinating the rendering the pop up
    function showModalToConfirmItem(item) {
        pendingItem = item; // Save the item temporarily
    
        const modal = document.getElementById("modalToConfirmItem");
        const modalInfo = document.querySelector("#modalItemInfo"); // ✅ No change here
    
        // Clear any previous content
        modalInfo.innerHTML = "";
    
        // Build the card preview
        const previewCard = renderInventoryItem({
            item,
            index: 0, // Preview just uses index 0
            CardContainerClass: "stock-container-addstock", // 💡 IMPORTANT: match the clean class, not "stock-card" anymore!
            ImageContainerClass: "stock-image-container-addstock",
            Identifier: "id",
            chipOneCardDisplayClass: "category-chip-addstock",
            chipOneSectionTitleClass: "chip-section-label-addstock",
            chipOneContainerClass: "category-chip-containeraddstock",
            cardOneContentOutsidePictureClass: "stock-content-addstock",
            carouselOneContainerClass: "carousel-addstock",
            carouselOneBtnClass: "carousel-btn-addstock",
            iconOneOfNextCarouselButtonClass: "carousel-icon-addstock",
            carouselOneTrackClass: "carousel-track-addstock",
            photoOneActualClass: "carousel-photo-addstock",
            hiddenOneFieldsCardContent: ["dymo_label_url", "description", "barcode", "cost", "created_at"]
        });

        // 🔍 Log the full preview card DOM element and item data
        console.log("Preview Card Element:", previewCard);

    
        modalInfo.appendChild(previewCard);
    
        // Re-activate lucide icons inside the modal
        lucide.createIcons();
    
        // Show the modal
        modal.classList.remove("hidden");
        
        updateBarcodeInputStateBasedOnModals();

    }
    
    //processing of the barcode, if present add, if not, render
    async function processBarcode(barcode) {
      if (!barcode) return;
    
      const input = document.getElementById("input-to-search-inventory-item");
      input.value = "";     // Clear input field
      input.focus();        // Auto-focus back for next scan
    
      if (currentBatch[barcode]) {
        incrementCardCount(barcode);
      } else {
        const item = await ExtractItemWithBarcodeFromSupabase(barcode, "item_types", "barcode", true);
        if (item) {
          showModalToConfirmItem(item);
        }
      }
    }
      
    //listener for the barcode
    function searchForBarcodeListener() {
        const input = document.getElementById("input-to-search-inventory-item");
        let debounceTimer = null;
      
        input.addEventListener("input", () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            processBarcode(input.value.trim());
          }, 200);
        });
    }

    //manual verification listerner count 
    setupManualCountVerificationListeners();


//#endregion  
    
document.addEventListener("DOMContentLoaded", async () => {
    const { data: { session }, error } = await supabase.auth.getSession();
  
    if (!session) {
      showToast("Please log in to scan items.");
      console.error("Session not found.");
      // Redirect to login
      setTimeout(() => {
        window.location.href = "login.html";
      }, 1500);
      return;
    }

    // ✅ FIX: Define currentUser globally
    window.currentUser = session.user;
  
    console.log("✅ Session loaded. User is authenticated.");
    searchForBarcodeListener();
    document.getElementById("input-to-search-inventory-item").focus();


    //event listeners

    document.addEventListener("click", (e) => {
        const id = e.target.dataset.id; // Common data-id used for most card actions

        // ⏪⏩ Carousel navigation: previous or next
        if (e.target.matches(".carousel-btn-addstock")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide({
              index: index,
              carouselTrackClass: "carousel-track-addstock",
              photoActualClass: "carousel-photo-addstock"
            }) : 
            nextSlide({
              index: index,
              carouselTrackClass: "carousel-track-addstock",
              photoActualClass: "carousel-photo-addstock"
            });      // go left or right
          }
        }

        if (e.target.matches(".carousel-btn")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide({
              index: index,
              carouselTrackClass: "carousel-track",
              photoActualClass: "carousel-photo"
            }) : 
            nextSlide({
              index: index,
              carouselTrackClass: "carousel-track",
              photoActualClass: "carousel-photo"
            });      // go left or right
          }
        }

    });

    //event listener for the home button
    document.getElementById("toggle-controller").addEventListener("click", () => {
      const header = document.querySelector(".container");
      const toggleBtn = document.getElementById("toggle-controller");
    
      // Toggle panel visibility
      header.classList.toggle("collapsed");
    
      // Trigger haptic pulse animation
      toggleBtn.classList.add("haptic");
      setTimeout(() => toggleBtn.classList.remove("haptic"), 1);
    }); 

    //event listener for the confirm manual count
    setupModalToConfirmItemListeners();

    //event listener for error if the manual count does not match scanned count
    setupMismatchResetModalListener();

    //event listener to assign the location to an item 
    setupAssignLocationModalListeners();

    //event listener to add locations to the locations table
    setupLocationModalListeners();

    let activeLocationDropdown = null;

    document.addEventListener("click", async (e) => {
      const isNameToggle = e.target.id === "assign-location-name-dropdown-toggle";
      const isBarcodeToggle = e.target.id === "assign-location-barcode-dropdown-toggle";

      if (!isNameToggle && !isBarcodeToggle) return;

      const button = e.target;
      const isName = isNameToggle;
      const menu = document.getElementById(isName ? "assign-location-name-dropdown-menu" : "assign-location-barcode-dropdown-menu");

      if (activeLocationDropdown && activeLocationDropdown !== menu) {
        activeLocationDropdown.classList.remove("show");
      }

      if (!menu.dataset.populated) {
        const options = isName
          ? await fetchUniqueLocationNames()
          : await fetchUniqueLocationBarcodes();

        renderDropdownOptionsCustom({
          menuId: isName
            ? "assign-location-name-dropdown-menu"
            : "assign-location-barcode-dropdown-menu",
          options,
          searchId: isName
            ? "assign-location-name-search"
            : "assign-location-barcode-search",
          placeholder: isName
            ? "Search or create location..."
            : "Search by barcode...",
          optionClass: "dropdown-option",
          dataAttribute: isName ? "location" : "barcode",
          optionsContainerClass: isName
            ? "location-name-dropdown-container"
            : "location-barcode-dropdown-container",
            onClick: (value, isNew, el) => {
              const hiddenInputId = isName ? "assign-location-name" : "assign-location-barcode";
              const toggleBtnId = isName
                ? "assign-location-name-dropdown-toggle"
                : "assign-location-barcode-dropdown-toggle";
            
              document.getElementById(hiddenInputId).value = value;
              document.getElementById(toggleBtnId).innerText = value;
            
              if (isNew && isName) {
                // 🪄 Only open the Add Location modal if creating a new location by name
                document.getElementById("location-name").value = value;
                toggleModal(true); // 👈 This is the key line that was missing
              } else {
                showToast(`🏷️ Selected ${isName ? "location" : "barcode"}: ${value}`);
              }
            
              menu.classList.remove("show");
              activeLocationDropdown = null;
            }
            
        });

        menu.dataset.populated = "true";
      }

      menu.classList.toggle("show");
      activeLocationDropdown = menu.classList.contains("show") ? menu : null;
    });

    //listerner for the password modal 
    setupPasswordConfirmationModal();


    // 🔁 Always refocus on barcode input when clicking outside modal or toast
    document.addEventListener("click", (e) => {
      const input = document.getElementById("input-to-search-inventory-item");
      const modal = document.getElementById("modalToConfirmItem");

      const clickedInsideModal = modal && modal.contains(e.target);
      const clickedToast = e.target.closest("#toast-container");
      const clickedInput = e.target === input;

      if (!clickedInsideModal && !clickedToast && !clickedInput) {
        input.focus();
      }
    });


});