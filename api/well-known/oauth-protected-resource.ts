import type { VercelRequest, VercelResponse } from "@vercel/node";

// OAuth 2.0 Protected Resource Metadata (RFC 9728).
// Distinct from oauth-authorization-server metadata. MCP clients per
// the 2025-03-26+ authorization spec consult this to discover which
// authorization server protects the MCP resource.

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
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${base}/`,
  });
}
