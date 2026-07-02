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
// Expanded X API surface — added 2026-05-14
// ───────────────────────────────────────────────────────────────────────────

const TWEET_FIELDS_FULL =
  "id,text,created_at,public_metrics,in_reply_to_user_id,referenced_tweets,entities,lang,conversation_id,author_id";
const USER_FIELDS_FULL =
  "id,name,username,public_metrics,description,verified,profile_image_url,location,url";

function clampMaxResults(value: number | undefined, lo: number, hi: number, def: number): number {
  const v = typeof value === "number" ? value : def;
  return Math.min(Math.max(v, lo), hi);
}

async function searchRecentTweets(query: string, max_results?: number) {
  if (!query || query.length < 2) throw new Error("query must be at least 2 chars");
  const data = await xRequest(`/tweets/search/recent`, {
    query,
    max_results: String(clampMaxResults(max_results, 10, 100, 10)),
    "tweet.fields": TWEET_FIELDS_FULL,
    expansions: "author_id",
    "user.fields": USER_FIELDS_FULL,
  });
  return { tweets: data.data ?? [], users: data.includes?.users ?? [], meta: data.meta };
}

async function lookupTweet(tweet_id: string) {
  const data = await xRequest(`/tweets/${encodeURIComponent(tweet_id)}`, {
    "tweet.fields": TWEET_FIELDS_FULL,
    expansions: "author_id",
    "user.fields": USER_FIELDS_FULL,
  });
  if (!data.data) throw new Error(`Tweet not found: ${tweet_id}`);
  return { tweet: data.data, author: data.includes?.users?.[0] };
}

async function lookupTweetsBatch(tweet_ids: string[]) {
  if (!Array.isArray(tweet_ids) || tweet_ids.length === 0) {
    throw new Error("tweet_ids must be a non-empty array");
  }
  if (tweet_ids.length > 100) {
    throw new Error("max 100 tweet_ids per batch");
  }
  const data = await xRequest(`/tweets`, {
    ids: tweet_ids.join(","),
    "tweet.fields": TWEET_FIELDS_FULL,
    expansions: "author_id",
    "user.fields": USER_FIELDS_FULL,
  });
  return { tweets: data.data ?? [], users: data.includes?.users ?? [], errors: data.errors ?? [] };
}

async function lookupUsersBatch(usernames: string[]) {
  if (!Array.isArray(usernames) || usernames.length === 0) {
    throw new Error("usernames must be a non-empty array");
  }
  if (usernames.length > 100) {
    throw new Error("max 100 usernames per batch");
  }
  const data = await xRequest(`/users/by`, {
    usernames: usernames.join(","),
    "user.fields": USER_FIELDS_FULL,
  });
  return { users: data.data ?? [], errors: data.errors ?? [] };
}

async function getUserMentions(username: string, max_results?: number) {
  const user = await getUserByUsername(username);
  const data = await xRequest(`/users/${user.id}/mentions`, {
    max_results: String(clampMaxResults(max_results, 5, 100, 10)),
    "tweet.fields": TWEET_FIELDS_FULL,
    expansions: "author_id",
    "user.fields": USER_FIELDS_FULL,
  });
  return { user, mentions: data.data ?? [], authors: data.includes?.users ?? [], meta: data.meta };
}

async function getTweetQuoteTweets(tweet_id: string, max_results?: number) {
  const data = await xRequest(`/tweets/${encodeURIComponent(tweet_id)}/quote_tweets`, {
    max_results: String(clampMaxResults(max_results, 10, 100, 10)),
    "tweet.fields": TWEET_FIELDS_FULL,
    expansions: "author_id",
    "user.fields": USER_FIELDS_FULL,
  });
  return { quote_tweets: data.data ?? [], authors: data.includes?.users ?? [], meta: data.meta };
}

async function getTweetRetweetedBy(tweet_id: string, max_results?: number) {
  const data = await xRequest(`/tweets/${encodeURIComponent(tweet_id)}/retweeted_by`, {
    max_results: String(clampMaxResults(max_results, 10, 100, 10)),
    "user.fields": USER_FIELDS_FULL,
  });
  return { users: data.data ?? [], meta: data.meta };
}

async function getTweetLikingUsers(tweet_id: string, max_results?: number) {
  const data = await xRequest(`/tweets/${encodeURIComponent(tweet_id)}/liking_users`, {
    max_results: String(clampMaxResults(max_results, 10, 100, 10)),
    "user.fields": USER_FIELDS_FULL,
  });
  return { users: data.data ?? [], meta: data.meta };
}

async function getUserFollowers(username: string, max_results?: number) {
  const user = await getUserByUsername(username);
  const data = await xRequest(`/users/${user.id}/followers`, {
    max_results: String(clampMaxResults(max_results, 10, 1000, 100)),
    "user.fields": USER_FIELDS_FULL,
  });
  return { user, followers: data.data ?? [], meta: data.meta };
}

async function getUserFollowing(username: string, max_results?: number) {
  const user = await getUserByUsername(username);
  const data = await xRequest(`/users/${user.id}/following`, {
    max_results: String(clampMaxResults(max_results, 10, 1000, 100)),
    "user.fields": USER_FIELDS_FULL,
  });
  return { user, following: data.data ?? [], meta: data.meta };
}

// ───────────────────────────────────────────────────────────────────────────
// Expanded X API surface — added 2026-07-02 (BMVC Builder signal sourcing)
// ───────────────────────────────────────────────────────────────────────────

async function getUserLikedTweets(username: string, max_results?: number) {
  const user = await getUserByUsername(username);
  const data = await xRequest(`/users/${user.id}/liked_tweets`, {
    max_results: String(clampMaxResults(max_results, 5, 100, 20)),
    "tweet.fields": TWEET_FIELDS_FULL,
    expansions: "author_id",
    "user.fields": USER_FIELDS_FULL,
  });
  return {
    user,
    liked_tweets: data.data ?? [],
    authors: data.includes?.users ?? [],
    meta: data.meta,
  };
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
  {
    name: "search_recent_tweets",
    description:
      "Search recent public tweets (last 7 days) by query. Supports X's standard search operators: 'from:user', 'to:user', '#tag', '@user', 'lang:en', 'has:links', '-filter:retweets', boolean OR / AND, quoted phrases. Use for: finding mentions of a product/topic, conversation discovery, competitive intel. Returns tweets + author info via expansions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "X search query, max 512 chars. Example: '\"black matter\" -is:retweet lang:en'",
        },
        max_results: {
          type: "number",
          description: "Results to return (10-100, default 10)",
          minimum: 10,
          maximum: 100,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_tweet",
    description:
      "Full tweet lookup by ID — returns tweet text, public_metrics, referenced_tweets, conversation_id, plus the author user object via expansion. Richer than get_tweet_metrics. Use when you need the full tweet content (e.g. to summarize a watchlist post Scout or Listener referenced).",
    inputSchema: {
      type: "object",
      properties: {
        tweet_id: { type: "string", description: "Numeric tweet ID" },
      },
      required: ["tweet_id"],
    },
  },
  {
    name: "lookup_tweets_batch",
    description:
      "Look up multiple tweets in a single call (up to 100 IDs). Cheaper than N individual calls when refreshing engagement on many entries. Returns tweets array + authors via expansion + per-ID errors for any missing tweets.",
    inputSchema: {
      type: "object",
      properties: {
        tweet_ids: {
          type: "array",
          items: { type: "string" },
          description: "Numeric tweet IDs (max 100)",
          maxItems: 100,
        },
      },
      required: ["tweet_ids"],
    },
  },
  {
    name: "lookup_users_batch",
    description:
      "Look up multiple users by usernames in a single call (up to 100). Used for hydrating watchlist user data, follower-count refreshes, batch profile pulls.",
    inputSchema: {
      type: "object",
      properties: {
        usernames: {
          type: "array",
          items: { type: "string" },
          description: "X handles without @ (max 100)",
          maxItems: 100,
        },
      },
      required: ["usernames"],
    },
  },
  {
    name: "get_user_mentions",
    description:
      "Get recent tweets mentioning a user (@-mentions). Useful for: tracking who's tagging Michael, watchlist-account mention monitoring, finding conversations to engage with. Returns mentions + authors via expansion.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X handle without @" },
        max_results: {
          type: "number",
          description: "Mentions to return (5-100, default 10)",
          minimum: 5,
          maximum: 100,
        },
      },
      required: ["username"],
    },
  },
  {
    name: "get_tweet_quote_tweets",
    description:
      "Get tweets that quote-posted a specific tweet. Useful for: finding who engaged substantively with a watchlist post (quote-posts indicate stronger interest than likes), discovering conversation threads, surfacing critic takes.",
    inputSchema: {
      type: "object",
      properties: {
        tweet_id: { type: "string", description: "Numeric tweet ID being quoted" },
        max_results: {
          type: "number",
          description: "Quote-tweets to return (10-100, default 10)",
          minimum: 10,
          maximum: 100,
        },
      },
      required: ["tweet_id"],
    },
  },
  {
    name: "get_tweet_retweeted_by",
    description:
      "Get users who reposted (retweeted) a specific tweet. Useful for: discovering the audience that amplified a piece of content, finding accounts aligned with a watchlist account's stance, mapping influence networks.",
    inputSchema: {
      type: "object",
      properties: {
        tweet_id: { type: "string", description: "Numeric tweet ID" },
        max_results: {
          type: "number",
          description: "Users to return (10-100, default 10)",
          minimum: 10,
          maximum: 100,
        },
      },
      required: ["tweet_id"],
    },
  },
  {
    name: "get_tweet_liking_users",
    description:
      "Get users who liked a specific tweet. Useful for: engagement-anomaly diagnosis (which kinds of accounts are liking the breakout post?), audience analysis, finding warm-intro candidates for a watchlist account.",
    inputSchema: {
      type: "object",
      properties: {
        tweet_id: { type: "string", description: "Numeric tweet ID" },
        max_results: {
          type: "number",
          description: "Users to return (10-100, default 10)",
          minimum: 10,
          maximum: 100,
        },
      },
      required: ["tweet_id"],
    },
  },
  {
    name: "get_user_followers",
    description:
      "Get the most recent followers of a user (single page only). Useful for: tracking who follows BM, watchlist follower-overlap analysis. Note: total follower lists can be huge; cap returns at the provided max_results.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X handle without @" },
        max_results: {
          type: "number",
          description: "Followers to return (10-1000, default 100)",
          minimum: 10,
          maximum: 1000,
        },
      },
      required: ["username"],
    },
  },
  {
    name: "get_user_following",
    description:
      "Get who a user is following (single page only). Useful for: finding adjacent operators a watchlist account considers worth following, discovering hidden voices in a niche.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X handle without @" },
        max_results: {
          type: "number",
          description: "Following to return (10-1000, default 100)",
          minimum: 10,
          maximum: 1000,
        },
      },
      required: ["username"],
    },
  },
  {
    name: "get_user_liked_tweets",
    description:
      "Get the most recent tweets a user has liked, by username. Primary use case: BMVC Builder pulling Michael's own trailing-day likes as a high-signal content source (his own explicit curation, weighted above raw watchlist volume). Returns liked tweets + author info via expansion — a liked tweet's own author may differ from the user whose likes you queried.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "The X handle whose likes to fetch (without @)",
        },
        max_results: {
          type: "number",
          description: "Liked tweets to return (5-100, default 20)",
          minimum: 5,
          maximum: 100,
        },
      },
      required: ["username"],
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
    case "search_recent_tweets":
      data = await searchRecentTweets(args.query, args.max_results);
      break;
    case "lookup_tweet":
      data = await lookupTweet(args.tweet_id);
      break;
    case "lookup_tweets_batch":
      data = await lookupTweetsBatch(args.tweet_ids);
      break;
    case "lookup_users_batch":
      data = await lookupUsersBatch(args.usernames);
      break;
    case "get_user_mentions":
      data = await getUserMentions(args.username, args.max_results);
      break;
    case "get_tweet_quote_tweets":
      data = await getTweetQuoteTweets(args.tweet_id, args.max_results);
      break;
    case "get_tweet_retweeted_by":
      data = await getTweetRetweetedBy(args.tweet_id, args.max_results);
      break;
    case "get_tweet_liking_users":
      data = await getTweetLikingUsers(args.tweet_id, args.max_results);
      break;
    case "get_user_followers":
      data = await getUserFollowers(args.username, args.max_results);
      break;
    case "get_user_following":
      data = await getUserFollowing(args.username, args.max_results);
      break;
    case "get_user_liked_tweets":
      data = await getUserLikedTweets(args.username, args.max_results);
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

  // Diagnostic logging (visible in Vercel function logs)
  try {
    const bodyForLog =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? { method: (req.body as any).method, id: (req.body as any).id, has_params: !!(req.body as any).params }
        : Array.isArray(req.body)
        ? { batch_size: req.body.length, methods: req.body.map((m: any) => m?.method) }
        : { raw: typeof req.body };
    console.log(
      "[mcp]",
      JSON.stringify({
        method: req.method,
        accept: req.headers.accept,
        ua: req.headers["user-agent"],
        has_auth: !!req.headers.authorization,
        mcp_session_id: req.headers["mcp-session-id"],
        mcp_protocol_version: req.headers["mcp-protocol-version"],
        body: bodyForLog,
      })
    );
  } catch (e) {
    console.log("[mcp] log_failed", String(e));
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const accept = (req.headers.accept ?? "").toString();

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

  // GET = open server-initiated SSE stream per Streamable HTTP transport.
  // Our server doesn't initiate messages (all responses are reactive to
  // POST), but strict MCP clients (Perplexity) expect a valid event-stream
  // here. We return a properly-typed empty stream with one heartbeat and
  // close cleanly. For non-SSE Accept (e.g. browser visit), return JSON.
  if (req.method === "GET") {
    if (accept.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.status(200);
      res.write(":heartbeat\n\n");
      return res.end();
    }
    return res.status(200).json({
      server: "blackmatter-xmcp",
      version: "0.1.0",
      tools: TOOLS.map((t) => t.name),
      transport: "JSON-RPC over HTTP POST",
    });
  }

  // DELETE = explicit session termination per Streamable HTTP transport.
  // We're stateless so there's nothing to clean up — just ack.
  if (req.method === "DELETE") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body;
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
