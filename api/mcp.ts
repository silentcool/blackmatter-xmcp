import type { VercelRequest, VercelResponse } from "@vercel/node";
import * as crypto from "node:crypto";

const X_API_BASE = "https://api.x.com/2";

// ───────────────────────────────────────────────────────────────────────────
// Auth — every incoming request must carry the shared MCP_AUTH_TOKEN
// ───────────────────────────────────────────────────────────────────────────

function checkAuth(req: VercelRequest): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return false;
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === expected;
}

// ───────────────────────────────────────────────────────────────────────────
// X API v2 client
// ───────────────────────────────────────────────────────────────────────────

async function xRequest(path: string, params: Record<string, string> = {}) {
  const url = new URL(X_API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
      "User-Agent": "blackmatter-xmcp/0.1",
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`X API ${response.status}: ${body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`X API returned non-JSON: ${body.slice(0, 200)}`);
  }
}

async function getUserByUsername(username: string) {
  const data = await xRequest(`/users/by/username/${encodeURIComponent(username)}`, {
    "user.fields": "id,name,username,public_metrics,description,verified",
  });
  if (!data.data) throw new Error(`User not found: ${username}`);
  return data.data;
}

async function getUserTweets(
  username: string,
  options: {
    max_results?: number;
    exclude_replies?: boolean;
    exclude_retweets?: boolean;
  } = {}
) {
  const user = await getUserByUsername(username);

  const excludes: string[] = [];
  if (options.exclude_replies !== false) excludes.push("replies");
  if (options.exclude_retweets !== false) excludes.push("retweets");

  const params: Record<string, string> = {
    max_results: String(Math.min(Math.max(options.max_results ?? 10, 5), 100)),
    "tweet.fields":
      "id,text,created_at,public_metrics,in_reply_to_user_id,referenced_tweets,entities,lang",
  };
  if (excludes.length) params.exclude = excludes.join(",");

  const data = await xRequest(`/users/${user.id}/tweets`, params);
  return { user, tweets: data.data ?? [], meta: data.meta };
}

async function getTweetMetrics(tweet_id: string) {
  const data = await xRequest(`/tweets/${encodeURIComponent(tweet_id)}`, {
    "tweet.fields": "id,text,public_metrics,created_at,author_id,entities,lang",
  });
  if (!data.data) throw new Error(`Tweet not found: ${tweet_id}`);
  return data.data;
}

// ───────────────────────────────────────────────────────────────────────────
// MCP tool definitions
// ───────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_user_tweets",
    description:
      "Get a public user's recent original tweets by username (@-handle without the @). Excludes replies and retweets by default. Returns user info + tweet array with public engagement metrics (likes, retweets, replies, impressions when available).",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "The X handle (e.g. 'garrytan'), without leading @",
        },
        max_results: {
          type: "number",
          description: "Max tweets to return (5-100, default 10). X API min is 5.",
          minimum: 5,
          maximum: 100,
        },
        exclude_replies: {
          type: "boolean",
          description: "Exclude reply tweets (default true)",
        },
        exclude_retweets: {
          type: "boolean",
          description: "Exclude retweets (default true)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "get_user_info",
    description:
      "Look up a user's profile by username. Returns user id, display name, follower counts, bio, verified status. Useful for caching display name once and reusing across many tweet lookups.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "The X handle (without @)",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "get_tweet_metrics",
    description:
      "Get a specific tweet's engagement metrics by numeric tweet ID. Useful for refreshing engagement on a previously-imported tweet (e.g. Scout's 30-day refresh pass).",
    inputSchema: {
      type: "object",
      properties: {
        tweet_id: {
          type: "string",
          description:
            "The numeric tweet/post ID (e.g. '2054350165281292390', extracted from a URL's trailing path segment)",
        },
      },
      required: ["tweet_id"],
    },
  },
];

async function callTool(name: string, args: any) {
  let data: any;
  switch (name) {
    case "get_user_tweets":
      data = await getUserTweets(args.username, args);
      break;
    case "get_user_info":
      data = await getUserByUsername(args.username);
      break;
    case "get_tweet_metrics":
      data = await getTweetMetrics(args.tweet_id);
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// MCP JSON-RPC dispatch
// ───────────────────────────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: any;
};

async function handleRpc(req: JsonRpcRequest) {
  const { id, method, params } = req;

  // Notifications (id absent or method starts with "notifications/") get no response
  const isNotification = id === undefined || method.startsWith("notifications/");

  try {
    let result: any;
    switch (method) {
      case "initialize":
        // Respect the client's requested protocolVersion if we support it,
        // otherwise return our latest supported version. We support the
        // 2024-11-05, 2025-03-26, and 2025-06-18 wire versions — the
        // tool-call surface hasn't changed in ways that affect us.
        {
          const supported = ["2025-06-18", "2025-03-26", "2024-11-05"];
          const clientVersion = (params?.protocolVersion as string) ?? "";
          const chosen = supported.includes(clientVersion) ? clientVersion : supported[0];
          result = {
            protocolVersion: chosen,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "blackmatter-xmcp", version: "0.1.0" },
          };
        }
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        if (!params?.name) throw new Error("Missing tool name");
        result = await callTool(params.name, params.arguments ?? {});
        break;
      case "ping":
        result = {};
        break;
      default:
        if (isNotification) return null;
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (e: any) {
    if (isNotification) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(e?.message ?? e) },
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Vercel serverless handler
// ───────────────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!checkAuth(req)) {
    const host = req.headers.host;
    const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
    const base = `${proto}://${host}`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="${base}", as_uri="${base}/.well-known/oauth-authorization-server"`
    );
    return res.status(401).json({ error: "Unauthorized" });
  }

  // GET = health/info ping. Streamable HTTP SSE is not implemented in v0.1.
  if (req.method === "GET") {
    return res.status(200).json({
      server: "blackmatter-xmcp",
      version: "0.1.0",
      tools: TOOLS.map((t) => t.name),
      transport: "JSON-RPC over HTTP POST",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;
  const accept = (req.headers.accept ?? "").toString();
  const wantsSse = accept.includes("text/event-stream");

  // Detect if this is an `initialize` call (single or in a batch) so we can
  // set Mcp-Session-Id on the response — some clients (Perplexity) require
  // a session id even when our server is stateless.
  const isInitialize = (Array.isArray(body) ? body : [body]).some(
    (m) => m && typeof m === "object" && m.method === "initialize"
  );
  if (isInitialize) {
    const sessionId = crypto.randomUUID();
    res.setHeader("Mcp-Session-Id", sessionId);
  }

  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(handleRpc));
    const nonNull = responses.filter((r) => r !== null);
    if (nonNull.length === 0) return res.status(204).end();
    if (wantsSse) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.status(200);
      for (const r of nonNull) {
        res.write(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
      }
      return res.end();
    }
    return res.status(200).json(nonNull);
  } else {
    const response = await handleRpc(body);
    if (response === null) {
      if (wantsSse) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        return res.status(202).end();
      }
      return res.status(204).end();
    }
    if (wantsSse) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.status(200);
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      return res.end();
    }
    return res.status(200).json(response);
  }
}
