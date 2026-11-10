import { defineConfig } from "@playwright/test";
import { AUTH_FILE, e2eDatabaseUrl } from "./e2e/seed";

const PORT = 3200;
const baseURL = `http://localhost:${PORT}`;
const startApp = process.env.CI
  ? `./node_modules/.bin/next start -p ${PORT}`
  : `node scripts/security/preflight.mjs && ./node_modules/.bin/next dev -p ${PORT}`;

// Tests share one database and reset it, so they must run one at a time.
export default defineConfig({
  testDir: "e2e",
  testMatch: /\.e2e\.ts$/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    { name: "chromium", dependencies: ["setup"], use: { storageState: AUTH_FILE } },
  ],
  webServer: {
    command: startApp,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DATABASE_URL: e2eDatabaseUrl(),
      AUTH_SECRET: "local-e2e-only",
      AUTH_URL: baseURL,
      AUTH_TRUST_HOST: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      SKIP_AUTH_BOOTSTRAP_CHECK: "1",
    },
  },
});
