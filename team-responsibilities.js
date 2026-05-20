document.addEventListener("DOMContentLoaded", () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }

  const printButton = document.getElementById("print-policy");
  if (printButton) {
    printButton.addEventListener("click", () => window.print());
  }
});
