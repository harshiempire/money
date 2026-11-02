import type { McpHttpHandler } from "@modelcontextprotocol/server";
import {
  McpInvalidToken,
  McpMissingToken,
  McpNotConfigured,
  McpRateLimited,
  type McpPrincipal,
} from "./auth";

export async function handleMcpHttp(
  request: Request,
  deps: {
    authenticate(request: Request): Promise<McpPrincipal>;
    fetch: McpHttpHandler["fetch"];
  },
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const origin = request.headers.get("origin");
  if (origin !== null) {
    try {
      if (new URL(origin).host !== new URL(request.url).host)
        return Response.json(
          { error: "Origin isn't allowed." },
          {
            status: 403,
            headers,
          },
        );
    } catch {
      return Response.json(
        { error: "Origin isn't allowed." },
        {
          status: 403,
          headers,
        },
      );
    }
  }
  try {
    const principal = await deps.authenticate(request);
    const response = await deps.fetch(request, {
      authInfo: {
        token: "money-authenticated",
        clientId: principal.tokenId,
        scopes: [principal.scope],
        extra: { principal },
      },
    });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof McpMissingToken || error instanceof McpInvalidToken) {
      const challenge = `Bearer realm="money"${request.headers.has("authorization") ? ', error="invalid_token"' : ""}`;
      return Response.json(
        { error: "A valid Money bearer token is required." },
        {
          status: 401,
          headers: {
            ...headers,
            "WWW-Authenticate": challenge,
          },
        },
      );
    }
    if (error instanceof McpRateLimited)
      return Response.json(
        { error: "Too many requests. Try again shortly." },
        {
          status: 429,
          headers: {
            ...headers,
            "Retry-After": String(error.retryAfterSeconds),
          },
        },
      );
    return Response.json(
      {
        error:
          error instanceof McpNotConfigured ? "MCP is not configured." : "MCP is temporarily unavailable.",
      },
      {
        status: 503,
        headers,
      },
    );
  }
}
