# blackmatter-xmcp

Minimal X (Twitter) API MCP server. Single Vercel serverless function. Built to give my own AI tooling structured X API access without scraping x.com.

## Tools exposed (14)

**Per-user reads:**
| Tool | Purpose |
|---|---|
| `get_user_tweets` | Recent original tweets for a username (excludes replies + retweets by default) |
| `get_user_info` | User profile lookup by username |
| `get_user_mentions` | Recent @-mentions of a user |
| `get_user_followers` | Most-recent follower list (single page) |
| `get_user_following` | Accounts the user follows (single page) |
| `get_user_liked_tweets` | Most-recent tweets a user has liked (single page) |

**Per-tweet reads:**
| Tool | Purpose |
|---|---|
| `get_tweet_metrics` | Engagement metrics only (cheapest refresh path) |
| `lookup_tweet` | Full tweet content + author via expansion |
| `get_tweet_quote_tweets` | Users who quote-posted a tweet |
| `get_tweet_retweeted_by` | Users who reposted a tweet |
| `get_tweet_liking_users` | Users who liked a tweet |

**Discovery + batch:**
| Tool | Purpose |
|---|---|
| `search_recent_tweets` | Last-7-days full-text search with X operators |
| `lookup_tweets_batch` | Up to 100 tweet IDs per call (cheap batch fetch) |
| `lookup_users_batch` | Up to 100 usernames per call |

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsilentcool%2Fblackmatter-xmcp&env=X_BEARER_TOKEN,MCP_AUTH_TOKEN&envDescription=X_BEARER_TOKEN%20from%20developer.x.com%20%2B%20a%20shared%20secret%20you%20generate)

During deploy, Vercel will prompt for two env vars:

- `X_BEARER_TOKEN` — your X API v2 Bearer Token from https://developer.x.com
- `MCP_AUTH_TOKEN` — a shared secret you generate. Run `openssl rand -hex 32` (or any other source). You'll paste this same value into Claude's custom MCP connector below.

After deploy, Vercel gives you a URL like `https://blackmatter-xmcp.vercel.app`. **The MCP endpoint is `<that-url>/api/mcp`** — note the `/api/mcp` suffix.

## Connect to Claude

1. https://claude.ai/customize/connectors → add custom MCP connector
2. **URL:** `https://<your-vercel-url>/api/mcp`
3. **Auth:** `Bearer <your MCP_AUTH_TOKEN>`
4. Save. The MCP is now attachable to any routine in https://claude.ai/code/routines.

## Verify it works

```bash
curl https://<your-vercel-url>/api/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return JSON with `tools` array containing the three tools.

```bash
curl https://<your-vercel-url>/api/mcp \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_user_info","arguments":{"username":"garrytan"}}}'
```

Should return Garry Tan's profile JSON.

## Cost

X API pay-per-use (Feb 2026 model):

- $0.005 per post read
- $0.01 per user lookup
- $0.005 per tweet-metrics call

My daily usage (~32 watchlist accounts × 5 tweets each, polled daily): roughly **$25/month** at full coverage. Trivial Vercel function-invocation cost on top.

## Architecture

One file: `api/mcp.ts`. Vercel serverless function. Stateless, no DB, no persistent state. JSON-RPC over HTTP POST. Bearer auth on every request.

## Local dev (optional)

```bash
npm install
echo "X_BEARER_TOKEN=…" > .env.local
echo "MCP_AUTH_TOKEN=…" >> .env.local
npx vercel dev
```

Endpoint runs at `http://localhost:3000/api/mcp`.

## Extending

To add a new tool, edit `api/mcp.ts`:

1. Add a new function near the X API client section (`getMentions`, `searchPosts`, etc.)
2. Add a tool definition to the `TOOLS` array
3. Add a case in `callTool`

The X API v2 reference: https://docs.x.com/x-api
