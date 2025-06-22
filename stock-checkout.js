/* ================= general wrapper to call it in other JS files and keep things clean============= */
window.checkoutModule = (function () {
  //global be used to start checkout mode
  let checkoutMode = false;
  
  //function to activate the toggle to start the checkout mode
  function setupCheckoutToggleButton(btnId = "toggle-checkout-mode") {
    const btn = document.getElementById(btnId);
    if (!btn) {
      console.warn(`No button found with ID: ${btnId}`);
      return;
    }

    btn.addEventListener("click", () => {
      checkoutMode = !checkoutMode;

      // Update button appearance
      btn.classList.toggle("active", checkoutMode);
      btn.title = checkoutMode ? "Exit Checkout Mode" : "Enter Checkout Mode";

      // Update body styling
      document.body.classList.toggle("checkout-mode-active", checkoutMode);
    });
  }

  return {
    setupCheckoutToggleButton,
  };
})();
