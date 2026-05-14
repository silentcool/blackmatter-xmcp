import type { VercelRequest, VercelResponse } from "@vercel/node";

// OAuth 2.0 Token Endpoint — supports only the Client Credentials Grant
// (RFC 6749 §4.4). Validates a pre-registered client_id + client_secret
// against env vars, returns MCP_AUTH_TOKEN as the access_token.
//
// This is the minimal OAuth surface required by Claude's custom MCP
// connector UI, which requires OAuth credentials instead of a static
// bearer header.

function parseFormBody(raw: any): Record<string, string> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, string>;
  }
  if (typeof raw === "string") {
    const params: Record<string, string> = {};
    for (const part of raw.split("&")) {
      const [k, v] = part.split("=");
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
    return params;
  }
  return {};
}

function parseBasicAuth(
  header: string | undefined
): { username: string; password: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return {
      username: decoded.slice(0, idx),
      password: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = parseFormBody(req.body);
  const basic = parseBasicAuth(req.headers.authorization as string | undefined);

  const grantType = body.grant_type;
  const clientId = body.client_id ?? basic?.username;
  const clientSecret = body.client_secret ?? basic?.password;

  if (grantType !== "client_credentials") {
    return res
      .status(400)
      .json({ error: "unsupported_grant_type" });
  }

  const expectedId = process.env.OAUTH_CLIENT_ID;
  const expectedSecret = process.env.OAUTH_CLIENT_SECRET;

  if (!expectedId || !expectedSecret) {
    return res.status(500).json({
      error: "server_misconfigured",
      error_description: "OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET not set on server",
    });
  }

  if (clientId !== expectedId || clientSecret !== expectedSecret) {
    return res.status(401).json({ error: "invalid_client" });
  }

  // Issue MCP_AUTH_TOKEN as the access token. The /api/mcp endpoint
  // validates Authorization: Bearer <MCP_AUTH_TOKEN> on every call.
  res.status(200).json({
    access_token: process.env.MCP_AUTH_TOKEN,
    token_type: "Bearer",
    expires_in: 31536000, // 1 year
    scope: "mcp",
  });
}
