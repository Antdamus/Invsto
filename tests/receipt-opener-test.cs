using System;
public static class ReceiptOpenerTest {
 public static int Main() {
  string valid = "invsto-receipt://tiktok/?order=577681512483951404&sku=1732855573992804598";
  if (ReceiptRequest.Parse(valid).LaunchUrl != "https://antdamus.github.io/Invsto/tiktok-receipt-launch.html?order=577681512483951404&sku=1732855573992804598") throw new Exception("Order/SKU precision lost.");
  if (ReceiptRequest.Parse("invsto-receipt://tiktok/?order=1234567890").Sku != "") throw new Exception("Optional SKU failed.");
  string[] bad = { null, "", "https://tiktok/?order=1234567890", "invsto-receipt://evil/?order=1234567890", "invsto-receipt://user@tiktok/?order=1234567890", "invsto-receipt://tiktok:99/?order=1234567890", valid + "&url=https://evil.test", valid + "&order=1234567890", valid + "#--argument", valid.Replace("1732855573992804598", "--new-window"), valid.Replace("577681512483951404", "1e18"), valid.Replace("577681512483951404", "%221234567890%22"), "invsto-receipt://tiktok/path?order=1234567890", "invsto-receipt://tiktok/?sku=1234567890" };
  foreach (string value in bad) { bool rejected=false;try { ReceiptRequest.Parse(value); }catch (ArgumentException) { rejected=true; }if(!rejected)throw new Exception("Accepted invalid request: " + value); }
  Console.WriteLine("Receipt opener: 2 valid and " + bad.Length + " invalid request cases passed; no installation or browser launch performed.");return 0;
 }
}
