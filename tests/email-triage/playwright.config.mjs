import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { loadEmailTriageEnv, repoRoot, resolveHarnessPath } from "./supabase-readonly-checks.mjs";

const env = loadEmailTriageEnv();
const baseURL = env.EMAIL_TRIAGE_BASE_URL || "http://127.0.0.1:4173";
const storageStatePath = resolveHarnessPath(
  env.EMAIL_TRIAGE_STORAGE_STATE,
  "tests/email-triage/.auth/admin.json",
);

function webServerFor(base) {
  if (String(env.EMAIL_TRIAGE_START_SERVER || "true").toLowerCase() === "false") return undefined;
  let url;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (!localHost || url.protocol !== "http:") return undefined;
  const port = url.port || "80";
  return {
    command: `python3 -m http.server ${port}`,
    cwd: repoRoot,
    url: base,
    reuseExistingServer: true,
    timeout: 30000,
  };
}

export default defineConfig({
  testDir: path.dirname(new URL(import.meta.url).pathname),
  testMatch: /email-triage-regression\.spec\.mjs/,
  timeout: 360000,
  expect: {
    timeout: 20000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "tests/email-triage/playwright-report", open: "never" }],
  ],
  use: {
    baseURL,
    actionTimeout: 30000,
    navigationTimeout: 45000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: webServerFor(baseURL),
  projects: [
    {
      name: "setup",
      grep: /@setup/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "chromium",
      grepInvert: /@setup/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: storageStatePath,
      },
    },
  ],
});

