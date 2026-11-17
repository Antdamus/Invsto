using System;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Web;
using System.Windows.Forms;
using Microsoft.Win32;

public sealed class ReceiptRequest {
    public string Order { get; private set; }
    public string Sku { get; private set; }
    public string LaunchUrl {
        get { return "https://antdamus.github.io/Invsto/tiktok-receipt-launch.html?order=" + Order + (Sku.Length > 0 ? "&sku=" + Sku : ""); }
    }
    public static ReceiptRequest Parse(string input) {
        Uri uri;
        if (input == null || input.Length > 256 || !Uri.TryCreate(input, UriKind.Absolute, out uri)
            || uri.Scheme != "invsto-receipt" || uri.Host != "tiktok" || uri.UserInfo.Length > 0
            || !uri.IsDefaultPort || uri.AbsolutePath != "/" || uri.Fragment.Length > 0)
            throw new ArgumentException("Open a TikTok receipt from Invsto.");
        NameValueCollection query = HttpUtility.ParseQueryString(uri.Query);
        foreach (string key in query.AllKeys)
            if ((key != "order" && key != "sku") || query.GetValues(key).Length != 1)
                throw new ArgumentException("Invalid receipt parameters.");
        string order = query["order"] ?? "", sku = query["sku"] ?? "";
        if (!Regex.IsMatch(order, @"\A[0-9]{10,24}\z") || (sku.Length > 0 && !Regex.IsMatch(sku, @"\A[0-9]{10,24}\z")))
            throw new ArgumentException("The receipt order or item is invalid.");
        return new ReceiptRequest { Order = order, Sku = sku };
    }
}

internal static class ReceiptOpener {
    private const string SchemeKey = @"Software\Classes\invsto-receipt";
    [STAThread]
    private static void Main(string[] args) {
        Application.EnableVisualStyles();
        try {
            if (args.Length == 0) { Install(); return; }
            if (args.Length != 1) throw new ArgumentException("Open a TikTok receipt from Invsto.");
            ReceiptRequest request = ReceiptRequest.Parse(args[0]);
            string firefox = FindFirefox();
            if (firefox == null) throw new InvalidOperationException("Install Firefox, then open the receipt again from Invsto.");
            Process.Start(new ProcessStartInfo {
                FileName = firefox,
                Arguments = "-new-tab \"" + request.LaunchUrl + "\"",
                UseShellExecute = false,
                CreateNoWindow = true
            });
        } catch (Exception error) {
            MessageBox.Show(error.Message, "Invsto receipt opener", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
    private static string FindFirefox() {
        foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe")) {
                    string value = key == null ? null : key.GetValue(null) as string;
                    if (!String.IsNullOrWhiteSpace(value)) {
                        string path = value.Trim('"');
                        if (Path.GetFileName(path).Equals("firefox.exe", StringComparison.OrdinalIgnoreCase) && File.Exists(path)) return path;
                    }
                }
        foreach (string folder in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) }) {
            string path = Path.Combine(folder, @"Mozilla Firefox\firefox.exe");
            if (File.Exists(path)) return path;
        }
        return null;
    }
    private static void Install() {
        if (FindFirefox() == null) throw new InvalidOperationException("Install Firefox before enabling the Invsto receipt opener.");
        DialogResult answer = MessageBox.Show(
            "Enable Firefox receipts for this Windows account?\n\nThis adds an Invsto link handler so Receipt settings can open TikTok receipts in Firefox. It does not change your default browser. The OG Firefox extension is also required for capturing photos.",
            "Invsto receipt opener", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
        if (answer != DialogResult.OK) return;
        string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "InvstoReceiptOpener");
        Directory.CreateDirectory(folder);
        string destination = Path.Combine(folder, "InvstoReceiptOpener.exe");
        if (!Path.GetFullPath(Application.ExecutablePath).Equals(Path.GetFullPath(destination), StringComparison.OrdinalIgnoreCase))
            File.Copy(Application.ExecutablePath, destination, true);
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(SchemeKey)) {
            key.SetValue("", "URL:Invsto TikTok Receipt");
            key.SetValue("URL Protocol", "");
            using (RegistryKey command = key.CreateSubKey(@"shell\open\command"))
                command.SetValue("", "\"" + destination + "\" \"%1\"");
        }
        MessageBox.Show("Firefox receipt opener is ready.\n\nIn Invsto, open TikTok → Receipt settings and select Firefox. Install the signed OG Firefox extension and sign in to Invsto and TikTok in Firefox before capturing photos.", "Invsto receipt opener", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
