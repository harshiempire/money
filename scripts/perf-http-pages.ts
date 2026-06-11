/**
 * Measure authenticated HTTP TTFB per route (dev/prod).
 * Usage: bun run perf:http-pages
 *
 * Requires BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, and a running server.
 */
const BASE = process.env.PERF_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.BOOTSTRAP_EMAIL;
const PASSWORD = process.env.BOOTSTRAP_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error("BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD required");
  process.exit(1);
}

const ROUTES = [
  "/import",
  "/timeline",
  "/",
  "/transactions",
  "/reimbursements",
  "/spend",
] as const;

async function login(): Promise<string> {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const csrf = (await csrfRes.json()) as { csrfToken: string };
  let cookie = (csrfRes.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  const body = new URLSearchParams({
    csrfToken: csrf.csrfToken,
    email: EMAIL,
    password: PASSWORD,
    callbackUrl: `${BASE}/`,
    json: "true",
  });

  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie,
    },
    body,
    redirect: "manual",
  });

  const newCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of newCookies) {
    const part = c.split(";")[0];
    if (part.includes("session-token")) {
      cookie = cookie ? `${cookie}; ${part}` : part;
    }
  }
  if (!cookie.includes("session-token")) {
    cookie =
      newCookies.map((c) => c.split(";")[0]).join("; ") || cookie;
  }
  return cookie;
}

async function measureRoute(
  cookie: string,
  path: string,
  warmup = false,
): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const ttfb = Math.round(performance.now() - start);
  if (!warmup) {
    console.log(`  ${path}: ${ttfb}ms (status ${res.status})`);
  }
  await res.arrayBuffer();
  return ttfb;
}

async function main() {
  console.log(`=== HTTP page TTFB (${BASE}) ===\n`);

  const health = await fetch(`${BASE}/login`);
  if (!health.ok) {
    console.error("Server not reachable at", BASE);
    process.exit(1);
  }

  console.log("Logging in...");
  const cookie = await login();
  if (!cookie.includes("session-token")) {
    console.error("Login failed — no session cookie");
    process.exit(1);
  }
  console.log("Login OK\n");

  console.log("Warm-up (/import):");
  await measureRoute(cookie, "/import", true);

  console.log("\nFirst pass:");
  const first: Record<string, number> = {};
  for (const route of ROUTES) {
    first[route] = await measureRoute(cookie, route);
  }

  console.log("\nSecond pass (warm pool):");
  for (const route of ROUTES) {
    await measureRoute(cookie, route);
  }

  const total = Object.values(first).reduce((a, b) => a + b, 0);
  console.log(
    `\nFirst-pass total: ${total}ms (avg ${Math.round(total / ROUTES.length)}ms)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
