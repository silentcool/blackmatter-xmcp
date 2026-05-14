import type { VercelRequest, VercelResponse } from "@vercel/node";

// OAuth 2.0 Authorization Server Metadata (RFC 8414).
// Served at /.well-known/oauth-authorization-server via vercel.json rewrite.

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method_not_allowed" });

  const host = req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  const base = `${proto}://${host}`;

  res.setHeader("Cache-Control", "public, max-age=3600");
  res.status(200).json({
    issuer: base,
    authorization_endpoint: `${base}/api/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    grant_types_supported: ["client_credentials"],
    response_types_supported: ["token"],
    token_endpoint_auth_methods_supported: [
      "client_secret_post",
      "client_secret_basic",
    ],
    scopes_supported: ["mcp"],
    // MCP-specific resource metadata fields
    resource_documentation: `${base}/`,
  });
}
