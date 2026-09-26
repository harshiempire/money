/**
 * "Sign in with ChatGPT" — the same OAuth flow the Codex CLI uses, so model
 * calls bill to the owner's ChatGPT plan instead of an API key.
 *
 * Unofficial: OpenAI tolerates personal use of your own subscription in
 * third-party tools but doesn't document this. Expect it to change; callers
 * must degrade, never break. Constants mirror openai/codex
 * (codex-rs/login/src/server.rs, auth/manager.rs).
 *
 * No `server-only` here — scripts/connect-chatgpt.ts imports it too.
 */

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_ORIGINATOR = "codex_cli_rs";

/** Money needs no connector scopes — only identity and a refresh token. */
const SCOPE = "openid profile email offline_access";

export interface ChatgptTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
}

export interface ChatgptAccount {
  accountId: string;
  planType: string | null;
  email: string | null;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("Malformed JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function accountFromIdToken(idToken: string): ChatgptAccount {
  const claims = decodeJwtPayload(idToken);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const accountId = auth.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("ChatGPT sign-in returned no account id");
  }
  return {
    accountId,
    planType: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
    email: typeof claims.email === "string" ? claims.email : null,
  };
}

export function accessTokenExpiry(accessToken: string): Date | null {
  const exp = decodeJwtPayload(accessToken).exp;
  return typeof exp === "number" ? new Date(exp * 1000) : null;
}

export function buildAuthorizeUrl(input: {
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(`${CHATGPT_ISSUER}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: CHATGPT_ORIGINATOR,
  }).toString();
  return url.toString();
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
};

export async function exchangeAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ChatgptTokens> {
  const res = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CHATGPT_CLIENT_ID,
      code_verifier: input.codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status})`);
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token || !body.refresh_token || !body.id_token) {
    throw new Error("Token exchange returned incomplete tokens");
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
  };
}

/**
 * Permanent: the refresh token is spent, revoked or expired — only a new
 * sign-in fixes it. Transient: network or server trouble — try again later.
 */
export class RefreshError extends Error {
  constructor(
    readonly permanent: boolean,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Refresh tokens are single-use (Codex has a "refresh token was already
 * used" error). The caller must persist the returned refresh token before
 * doing anything else, and must hold a lock so two requests never spend the
 * same one.
 */
export async function refreshChatgptTokens(
  current: ChatgptTokens,
): Promise<ChatgptTokens> {
  let res: Response;
  try {
    res = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CHATGPT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new RefreshError(false, "Could not reach ChatGPT sign-in");
  }
  if (res.status === 400 || res.status === 401) {
    throw new RefreshError(true, `ChatGPT refused the refresh (HTTP ${res.status})`);
  }
  if (!res.ok) throw new RefreshError(false, `ChatGPT sign-in error (HTTP ${res.status})`);
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) throw new RefreshError(false, "Refresh returned no access token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? current.refreshToken,
    idToken: body.id_token ?? current.idToken,
  };
}

/** Best-effort RFC 7009 revocation; the result is only reported. */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${CHATGPT_ISSUER}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: "refresh_token",
        client_id: CHATGPT_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
