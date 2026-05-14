import type { VercelRequest, VercelResponse } from "@vercel/node";
import * as crypto from "node:crypto";

// OAuth 2.0 Token Endpoint (RFC 6749 §3.2) — supports two grant types:
//
//   1. client_credentials  — service-to-service, validates pre-registered
//      client_id + client_secret directly, returns access token.
//
//   2. authorization_code  — Claude's flow. Validates the HMAC-signed
//      code minted by /api/oauth/authorize, optionally verifies PKCE
//      code_verifier against the stored code_challenge, then returns
//      access token.
//
// In both flows the access_token returned is the same value that
// /api/mcp validates: MCP_AUTH_TOKEN.

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

function verifyCode(code: string): { ok: true; payload: any } | { ok: false; error: string } {
  const secret = process.env.OAUTH_CLIENT_SECRET ?? "";
  const parts = code.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed_code" };
  const [payloadB64, sig] = parts;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  // Constant-time comparison
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, error: "invalid_signature" };
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, error: "code_expired" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, error: "malformed_payload" };
  }
}

function verifyPkce(
  codeChallenge: string | null,
  codeChallengeMethod: string,
  codeVerifier: string | null | undefined
): boolean {
  // No challenge recorded -> no verifier required (non-PKCE flow)
  if (!codeChallenge) return true;
  if (!codeVerifier) return false;
  if (codeChallengeMethod === "S256") {
    const hash = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return hash === codeChallenge;
  }
  if (codeChallengeMethod === "plain") {
    return codeVerifier === codeChallenge;
  }
  return false;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = parseFormBody(req.body);
  const basic = parseBasicAuth(req.headers.authorization as string | undefined);

  const grantType = body.grant_type;
  const clientId = body.client_id ?? basic?.username;
  const clientSecret = body.client_secret ?? basic?.password;

  const expectedId = process.env.OAUTH_CLIENT_ID;
  const expectedSecret = process.env.OAUTH_CLIENT_SECRET;

  if (!expectedId || !expectedSecret) {
    return res.status(500).json({
      error: "server_misconfigured",
      error_description: "OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET not set",
    });
  }

  // For authorization_code grant with PKCE, client_secret may be absent
  // (public client model). We still require client_id to match.
  if (clientId !== expectedId) {
    return res.status(401).json({ error: "invalid_client" });
  }

  if (grantType === "client_credentials") {
    // Service-to-service: require secret
    if (clientSecret !== expectedSecret) {
      return res.status(401).json({ error: "invalid_client" });
    }
    return res.status(200).json({
      access_token: process.env.MCP_AUTH_TOKEN,
      token_type: "Bearer",
      expires_in: 31536000,
      scope: "mcp",
    });
  }

  if (grantType === "authorization_code") {
    const code = body.code;
    const redirectUri = body.redirect_uri;
    const codeVerifier = body.code_verifier;

    if (!code) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "code required",
      });
    }

    const codeResult = verifyCode(code);
    if (!codeResult.ok) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: codeResult.error,
      });
    }
    const payload = codeResult.payload;

    if (payload.ru && redirectUri && payload.ru !== redirectUri) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "redirect_uri_mismatch",
      });
    }

    if (!verifyPkce(payload.cc, payload.ccm, codeVerifier)) {
      return res.status(400).json({
        error: "invalid_grant",
        error_description: "pkce_failed",
      });
    }

    // For confidential clients in the authorization_code flow, we
    // also require the client_secret. Public clients (PKCE only) MAY
    // omit. Since Claude stores the secret, we accept either case
    // but require correctness if provided.
    if (clientSecret !== undefined && clientSecret !== expectedSecret) {
      return res.status(401).json({ error: "invalid_client" });
    }

    return res.status(200).json({
      access_token: process.env.MCP_AUTH_TOKEN,
      token_type: "Bearer",
      expires_in: 31536000,
      scope: "mcp",
    });
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
}
