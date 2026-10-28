import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { handleMcpHttp } from "@/lib/mcp/http";
import { deriveMcpRefKey, deriveMcpRevKey } from "@/lib/mcp/refs";
import { buildMcpServer, principalFromContext } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mcp = createMcpHandler(
  async (ctx) => {
    const principal = principalFromContext(ctx);
    const key = deriveMcpRefKey(process.env.AUTH_SECRET);
    const [{ mcpReadOps }, { mcpWriteOps }] = await Promise.all([
      import("@/lib/mcp/read-ops"), import("@/lib/mcp/write-ops"),
    ]);
    return buildMcpServer(principal, mcpReadOps, key, deriveMcpRevKey(process.env.AUTH_SECRET), mcpWriteOps);
  },
  {
    legacy: "stateless",
    responseMode: "json",
    maxRequestBodySize: 256 * 1024,
  },
);

const handler = (request: Request) =>
  handleMcpHttp(request, {
    authenticate: authenticateMcpRequest,
    fetch: mcp.fetch,
  });
export { handler as POST, handler as GET, handler as DELETE };
