import type { VercelRequest, VercelResponse } from "@vercel/node";
import * as crypto from "node:crypto";

// OAuth 2.0 Authorization Endpoint (RFC 6749 §3.1) — supports the
// Authorization Code Grant with PKCE (RFC 7636).
//
// This endpoint auto-approves any request from the configured
// OAUTH_CLIENT_ID. Since the only legitimate client (Claude) already
// holds the client_secret needed for the subsequent token exchange,
// there's no human user to consent — we just mint a code and redirect.
//
// The code is HMAC-signed and self-contained (no server-side state).
// It encodes the PKCE code_challenge, the requested redirect_uri, and
// an expiry. /api/oauth/token verifies the signature + PKCE on
// exchange.

const CODE_TTL_SECONDS = 600; // 10 minutes

function signCode(payload: Record<string, unknown>): string {
  const secret = process.env.OAUTH_CLIENT_SECRET ?? "";
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

function getParams(req: VercelRequest): Record<string, string> {
  if (req.method === "GET") {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      result[k] = Array.isArray(v) ? (v[0] ?? "") : (v as string);
    }
    return result;
  }
  // POST — body might be form-encoded or JSON
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body as Record<string, string>;
  }
  if (typeof req.body === "string") {
    const result: Record<string, string> = {};
    for (const part of req.body.split("&")) {
      const [k, v] = part.split("=");
      if (k) result[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
    return result;
  }
  return {};
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const params = getParams(req);
  const responseType = params.response_type;
  const clientId = params.client_id;
  const redirectUri = params.redirect_uri;
  const state = params.state ?? "";
  const codeChallenge = params.code_challenge ?? "";
  const codeChallengeMethod = params.code_challenge_method ?? "plain";

  if (responseType !== "code") {
    return res
      .status(400)
      .json({ error: "unsupported_response_type" });
  }

  const expectedId = process.env.OAUTH_CLIENT_ID;
  if (!expectedId || clientId !== expectedId) {
    return res.status(401).json({ error: "invalid_client" });
  }

  if (!redirectUri) {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "redirect_uri required",
    });
  }

  // Mint a signed, self-contained authorization code
  const code = signCode({
    cid: clientId,
    cc: codeChallenge || null,
    ccm: codeChallengeMethod,
    ru: redirectUri,
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS,
  });

  // Redirect back to client with code + state
  try {
    const cb = new URL(redirectUri);
    cb.searchParams.set("code", code);
    if (state) cb.searchParams.set("state", state);
    return res.redirect(302, cb.toString());
  } catch {
    return res.status(400).json({
      error: "invalid_request",
      error_description: "redirect_uri must be a valid absolute URL",
    });
  }
}
