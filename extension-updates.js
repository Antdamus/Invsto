(function () {
  "use strict";

  const section = document.getElementById("extension-updates");
  if (!section) return;
  const badge = document.getElementById("extension-update-badge");
  const installed = document.getElementById("extension-installed-version");
  const latest = document.getElementById("extension-latest-version");
  const message = document.getElementById("extension-update-message");
  const download = document.getElementById("extension-download");
  const checkButton = document.getElementById("extension-check");
  const scriptUrl = document.currentScript.src;
  const releaseUrl = new URL("downloads/og-ebay-order-link-release.json", scriptUrl);
  const downloadUrl = new URL("downloads/OG-eBay-Order-Link.zip", scriptUrl);
  let checking = false;
  let lastCheck = 0;

  function versionParts(value) {
    return typeof value === "string" && /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(value)
      ? value.split(".").map(Number) : null;
  }

  function compareVersions(a, b) {
    const left = versionParts(a), right = versionParts(b);
    for (let i = 0; i < 4; i += 1) {
      const difference = (left[i] || 0) - (right[i] || 0);
      if (difference) return Math.sign(difference);
    }
    return 0;
  }

  function readInstalledVersion() {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const finish = (version) => {
        window.clearInterval(retry);
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(version);
      };
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data;
        if (data?.type !== "OG_EBAY_EXTENSION_VERSION_RESPONSE" || data.requestId !== requestId) return;
        if (versionParts(data.version)) finish(data.version);
      };
      const request = () => window.postMessage({type: "OG_EBAY_EXTENSION_VERSION_REQUEST", requestId}, window.location.origin);
      window.addEventListener("message", onMessage);
      // The document_idle content script may load after this page script.
      const retry = window.setInterval(request, 500);
      const timeout = window.setTimeout(() => finish(null), 4000);
      request();
    });
  }

  async function readRelease() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    try {
      const url = new URL(releaseUrl);
      url.searchParams.set("check", Date.now());
      const response = await fetch(url, {cache: "no-store", signal: controller.signal});
      if (!response.ok) throw new Error("Release unavailable");
      const release = await response.json();
      if (!versionParts(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error("Invalid release");
      return release;
    } catch (_) {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function setStatus(state, label, detail) {
    section.dataset.state = state;
    badge.textContent = label;
    message.textContent = detail;
  }

  async function checkForUpdates() {
    if (checking) return;
    checking = true;
    lastCheck = Date.now();
    checkButton.disabled = true;
    installed.textContent = latest.textContent = "Checking…";
    download.textContent = "Download extension ZIP";
    // Do not retain a stale version-specific download if this check fails.
    download.href = downloadUrl.href;
    setStatus("checking", "Checking…", "Checking the installed extension and latest release…");
    try {
      const [version, release] = await Promise.all([readInstalledVersion(), readRelease()]);
      installed.textContent = version ? `v${version}` : "Not detected";
      latest.textContent = release ? `v${release.version}` : "Unavailable";
      if (release) {
        const url = new URL(downloadUrl);
        url.searchParams.set("v", release.version);
        url.searchParams.set("build", release.sha256.slice(0, 12));
        download.href = url.href;
        download.textContent = `Download v${release.version} ZIP`;
      }
      if (!release) {
        setStatus("unknown", "Check unavailable", "Could not check the latest release. Check your connection and try again; this browser’s update status is unverified.");
      } else if (!version) {
        setStatus("unknown", "Version not detected", "This browser did not report an extension version. Older versions need one manual update to enable this check. See the steps below if it is missing, disabled, or already updated.");
      } else {
        const comparison = compareVersions(version, release.version);
        if (comparison < 0) {
          setStatus("outdated", "Update available", `This browser has v${version}. Download v${release.version} and follow the update steps below.`);
        } else if (comparison > 0) {
          setStatus("newer", "Newer version installed", `This browser has v${version}, which is newer than the published v${release.version}. No downgrade is needed.`);
        } else {
          setStatus("current", "Up to date", `This browser is running the latest published extension, v${version}.`);
        }
      }
    } catch (_) {
      installed.textContent = latest.textContent = "Unavailable";
      setStatus("unknown", "Check unavailable", "Could not verify the extension version. Refresh this page and try again.");
    } finally {
      checking = false;
      checkButton.disabled = false;
    }
  }

  function checkIfStale() {
    if (!document.hidden && Date.now() - lastCheck >= 5 * 60 * 1000) checkForUpdates();
  }

  function openFromLink() {
    if (window.location.hash === "#extension-updates") section.open = true;
  }

  checkButton.addEventListener("click", checkForUpdates);
  section.addEventListener("toggle", () => { if (section.open) checkIfStale(); });
  window.addEventListener("hashchange", openFromLink);
  document.addEventListener("visibilitychange", checkIfStale);
  window.setInterval(checkIfStale, 5 * 60 * 1000);
  openFromLink();
  checkForUpdates();
})();
