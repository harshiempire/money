/**
 * Connects a Money user to their own ChatGPT plan for the assistant.
 * Runs on your machine (the sign-in needs a browser and localhost:1455) and
 * writes sealed tokens to whichever DATABASE_URL is loaded.
 *
 * Money gets its own token family — it does not reuse ~/.codex/auth.json,
 * because refresh tokens are single-use and the two would log each other out.
 *
 * Usage:
 *   bun run connect-chatgpt                      # user = BOOTSTRAP_EMAIL
 *   bun run connect-chatgpt --email you@example.com
 *   bun run connect-chatgpt --disconnect         # delete + revoke
 *
 * Needs AI_TOKEN_ENCRYPTION_KEY — the same value the deployed app uses.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "./lib/db";
import { loadSecretKey, open, seal } from "../src/lib/crypto/secret-box";
import {
  accessTokenExpiry,
  accountFromIdToken,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  revokeRefreshToken,
} from "../src/lib/ai/chatgpt/oauth";

const PROVIDER = "chatgpt";
const PORT = 1455;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/auth/callback`;

const args = process.argv.slice(2);
const emailArg = args.includes("--email") ? args[args.indexOf("--email") + 1] : undefined;
const email = (emailArg ?? process.env.BOOTSTRAP_EMAIL)?.trim().toLowerCase();
const disconnect = args.includes("--disconnect");

if (!email) {
  console.error("Pass --email <money login email> or set BOOTSTRAP_EMAIL");
  process.exit(1);
}
const key = loadSecretKey();

const [user] = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(sql`lower(${schema.users.email}) = ${email}`)
  .limit(1);
if (!user) {
  console.error(`No Money user with email ${email}`);
  process.exit(1);
}
const context = `${user.id}:${PROVIDER}`;
const where = and(eq(schema.aiConnections.userId, user.id), eq(schema.aiConnections.provider, PROVIDER));

if (disconnect) {
  const [row] = await db.select().from(schema.aiConnections).where(where).limit(1);
  if (!row) {
    console.log("Not connected — nothing to do.");
    process.exit(0);
  }
  const revoked = await revokeRefreshToken(open(row.refreshTokenSealed, context, key));
  await db.delete(schema.aiConnections).where(where);
  console.log(`Disconnected ${email}. Refresh token revoke: ${revoked ? "ok" : "not confirmed"}.`);
  process.exit(0);
}

const verifier = randomBytes(64).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(32).toString("base64url");
const authUrl = buildAuthorizeUrl({ redirectUri: REDIRECT_URI, codeChallenge: challenge, state });

const done = Promise.withResolvers<void>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state) return new Response("State mismatch", { status: 400 });
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      done.reject(new Error(`Sign-in failed: ${error ?? "no code"}`));
      return new Response("Sign-in failed — see terminal.", { status: 400 });
    }
    try {
      const tokens = await exchangeAuthorizationCode({ code, redirectUri: REDIRECT_URI, codeVerifier: verifier });
      const account = accountFromIdToken(tokens.idToken);
      const values = {
        providerAccountId: account.accountId,
        planType: account.planType,
        accessTokenSealed: seal(tokens.accessToken, context, key),
        refreshTokenSealed: seal(tokens.refreshToken, context, key),
        accessExpiresAt: accessTokenExpiry(tokens.accessToken),
        status: "active",
        updatedAt: new Date(),
      };
      await db
        .insert(schema.aiConnections)
        .values({ userId: user.id, provider: PROVIDER, ...values })
        .onConflictDoUpdate({
          target: [schema.aiConnections.userId, schema.aiConnections.provider],
          set: values,
        });
      console.log(`\nConnected Money user ${email} to ChatGPT (${account.email ?? "?"}, plan ${account.planType ?? "?"}).`);
      console.log(`\nTo turn AI reading on, set in Vercel (and .env.local):`);
      console.log(`  AI_ALLOWED_USER_IDS=${user.id}`);
      console.log(`  AI_TOKEN_ENCRYPTION_KEY=<the same key used here>`);
      done.resolve();
      return new Response("Money is connected to ChatGPT. You can close this tab.");
    } catch (err) {
      done.reject(err as Error);
      return new Response("Connecting failed — see terminal.", { status: 500 });
    }
  },
});

console.log(`Sign in with the ChatGPT account whose plan Money should use:\n\n${authUrl}\n`);
spawn("open", [authUrl], { stdio: "ignore", detached: true }).unref();

const timeout = setTimeout(() => done.reject(new Error("Timed out after 10 minutes")), 10 * 60_000);
try {
  await done.promise;
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  server.stop(true);
}
