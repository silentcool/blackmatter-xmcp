import type { VercelRequest, VercelResponse } from "@vercel/node";

// OAuth 2.0 Dynamic Client Registration (RFC 7591). Some MCP clients
// (notably Perplexity) attempt DCR before falling back to user-entered
// credentials, and the failure mode if /register is missing or 404s
// can be silent (connector reports "connected" but tool discovery
// never runs).
//
// Our implementation is intentionally degenerate: every registration
// request returns the SAME pre-shared OAUTH_CLIENT_ID +
// OAUTH_CLIENT_SECRET that's already configured on the server. This
// trades the per-client isolation DCR is meant to provide for a much
// simpler stateless server.
//
// Threat model: anyone calling /register obtains the same credentials.
// They still have to complete OAuth (no bypass of the token endpoint)
// and the access_token they get is the same MCP_AUTH_TOKEN any
// authenticated caller has. Acceptable for a single-team MCP.

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const expectedId = process.env.OAUTH_CLIENT_ID;
  const expectedSecret = process.env.OAUTH_CLIENT_SECRET;

  if (!expectedId || !expectedSecret) {
    return res.status(500).json({
      error: "server_misconfigured",
      error_description: "OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET not set",
    });
  }

  // Parse incoming registration request (RFC 7591 §2)
  const body =
    req.body && typeof req.body === "object" ? (req.body as any) : {};

  const redirect_uris: string[] = Array.isArray(body.redirect_uris)
    ? body.redirect_uris
    : [];

  console.log(
    "[register]",
    JSON.stringify({
      client_name: body.client_name,
      redirect_uris,
      grant_types: body.grant_types,
      scope: body.scope,
    })
  );

  // RFC 7591 §3.2.1 — successful response
  return res.status(201).json({
    client_id: expectedId,
    client_secret: expectedSecret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    // 0 means "never expires"
    client_secret_expires_at: 0,
    redirect_uris,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "client_credentials"],
    response_types: ["code"],
    scope: "mcp",
    client_name: body.client_name ?? "blackmatter-xmcp-client",
  });
}
