import dotenv from 'dotenv'
dotenv.config()
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express from 'express'
import { randomUUID } from 'node:crypto'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { buildBrandContext, savePost } from './notion.js'
import { createTypefullyDraft, getTypefullyScheduled, getTypefullyPublished } from './typefully.js'
import { getUserPosts, searchPosts, getPostMetrics, getUSTrends } from './x.js'

// ─── Server Factory ───────────────────────────────────────────────────────────
// A fresh Server instance must be created per connection — the MCP SDK does not
// support connecting a single Server to multiple transports simultaneously.

function createMcpServer() {
  const server = new Server(
    { name: 'definitive-brain', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {} } }
  )

// ─── Prompts ──────────────────────────────────────────────────────────────────
// These are loaded by Claude automatically on connect — no system prompt needed in config

const PROMPTS = {
  'definitive-brain-instructions': {
    name: 'definitive-brain-instructions',
    description: 'Skills and behavior instructions for the Definitive Brain. Claude loads this automatically.',
    arguments: []
  }
}

const INSTRUCTIONS = `You are a seasoned social media writer for Definitive, an advanced DeFi trading platform on Base, Solana, and every major chain.

You are the internal content brain for the Definitive team, running as a Slackbot. You respond directly in Slack — keep responses concise and use Slack markdown (bold with *text*, italic with _text_, code with \`text\`). Avoid long prose, unnecessary headers, or excessive bullet points.

## Slash Command Routing

Any message starting with / is a skill — execute it immediately without asking for clarification.

Examples:
- "/skills" → show the skill menu
- "/morning" → run the morning briefing
- "/audit @DefinitiveFi" → audit that profile
- "/draft leaderboard update" → draft posts about that topic

## Skills

---

**/morning**
Run the daily content intelligence briefing.
1. Call \`analyze_trends\` with brand_name "Definitive", trend_limit 20, posts_per_trend 1
2. Score every trend against Definitive's content pillars
3. Return: ranked opportunities (relevance score + why it fits + specific draft angle), and a clear "skip" list for irrelevant trends
4. End with: "Type /draft [angle] to turn any of these into a post"

---

**/audit [@handle]**
Audit any X profile's recent content.
1. Call \`audit_x_profile\` with the provided handle, count 20
2. Rank by impressions — flag top 3 and bottom 3 with explanation
3. Identify content gaps and over-reliance on any single format
4. Give 3 specific actionable recommendations

---

**/draft [topic or angle]**
Generate post copy in Definitive's brand voice.
1. If thread context is provided, use it as the topic — no need for the user to restate it
2. Call \`get_brand_context\` with brand_name "Definitive"
3. Generate 3 post variants following all voice rules
4. Label each variant with the approach Claude chose — no rationale, no "why it fits" section, no additional commentary after the variants

---

**/save [post text]**
Save a post or finding to the Notion brain.
1. If a URL is provided, extract the post ID and call \`get_x_post_metrics\` first to get real impressions/likes/RTs
2. Infer notes from the content and metrics — write a concise read on why it performed well or poorly — do not ask the user
3. Only ask the user for save_reason if it's not obvious from context (Top Performer vs Avoid)
4. Call \`save_post_to_notion\` with all available info
5. Confirm saved

---

**/schedule [post text]**
Send copy directly to Typefully queue — no confirmation needed.
1. If the user includes a time with a timezone (e.g. "tomorrow at 7:30am PT"), convert it to UTC and pass as schedule_date. If a time is given without a timezone, ask for the timezone before proceeding.
2. Call \`create_typefully_draft\` immediately with the post text
3. Reply with only the tool's confirmation message — no extra commentary

---

**/skills** or **/help**
List all available skills with a one-line description of each.

---

## Always-on rules
- Always call \`get_brand_context\` before drafting — never generate copy without it
- If the user asks something outside these skills, answer normally`

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: Object.values(PROMPTS)
}))

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params
  if (name !== 'definitive-brain-instructions') {
    throw new Error(`Unknown prompt: ${name}`)
  }
  return {
    description: PROMPTS[name].description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: INSTRUCTIONS
        }
      }
    ]
  }
})

// ─── Tools ────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ── Notion ────────────────────────────────────────────────────────────────

    {
      name: 'get_brand_context',
      description: 'Load full brand context from Notion — profile, voice rules, top posts, patterns to avoid.',
      inputSchema: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Brand name e.g. "Definitive"' }
        },
        required: ['brand_name']
      }
    },
    {
      name: 'save_post_to_notion',
      description: 'Save a post or finding to Notion for future reference.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          brand: { type: 'string', description: 'The X handle of the account — e.g. "@DefinitiveFi"' },
          impressions: { type: 'number' },
          likes: { type: 'number' },
          retweets: { type: 'number' },
          notes: { type: 'string' },
          url: { type: 'string' },
          save_reason: {
            type: 'string',
            enum: ['Top Performer', 'Avoid']
          },
          post_date: { type: 'string', description: 'ISO 8601 date the post was published e.g. "2026-02-24"' }
        },
        required: ['text', 'brand', 'save_reason']
      }
    },

    // ── X API ─────────────────────────────────────────────────────────────────

    {
      name: 'analyze_trends',
      description: 'Fetches current US trending topics from X with top posts per trend, scored against a brand\'s content pillars. Returns ranked opportunities with draft angles.',
      inputSchema: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Brand to score trends against e.g. "Definitive"' },
          trend_limit: { type: 'number', description: 'How many US trends to fetch.' },
          posts_per_trend: { type: 'number', description: 'Top posts to fetch per trend.' }
        },
        required: ['brand_name']
      }
    },
    {
      name: 'audit_x_profile',
      description: 'Fetch the last N posts from any X profile with full engagement metrics. Use this as the data source for content audits.',
      inputSchema: {
        type: 'object',
        properties: {
          handle: { type: 'string', description: 'X handle e.g. "@DefinitiveFi"' },
          count: { type: 'number', description: 'Number of posts to fetch.' }
        },
        required: ['handle']
      }
    },
    {
      name: 'search_x_posts',
      description: 'Search recent X posts by keyword, hashtag, or account.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query e.g. "from:DefinitiveFi", "#Base", "trading contest"' },
          count: { type: 'number', description: 'Number of results. Default 20, max 100.' }
        },
        required: ['query']
      }
    },
    {
      name: 'get_x_post_metrics',
      description: 'Get current engagement metrics for specific post IDs. Extract the post ID from an X URL (the number after /status/).',
      inputSchema: {
        type: 'object',
        properties: {
          post_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of X post IDs'
          }
        },
        required: ['post_ids']
      }
    },

    // ── Typefully ─────────────────────────────────────────────────────────────

    {
      name: 'create_typefully_draft',
      description: 'Send post copy to Typefully as a draft.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Post content. Use \\n\\n between thread tweets.' },
          schedule_date: { type: 'string', description: 'ISO 8601 datetime in UTC. Convert natural language input (e.g. "tomorrow at 7:30am PT") to UTC before passing. If the user gives a time without a timezone, ask them to specify one before calling this tool. Leave empty to save to queue.' }
        },
        required: ['content']
      }
    },
    {
      name: 'get_typefully_scheduled',
      description: 'Get all scheduled drafts in Typefully.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_typefully_published',
      description: 'Get recently published posts from Typefully.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'skills',
      description: 'List all available Definitive Brain skills and how to use them. Call this when the user types /skills or /help or asks what you can do.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'fetch_url',
      description: 'Fetch the content of a URL and return it as plain text. Use when the user shares a link and wants to draft a post based on it.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' }
        },
        required: ['url']
      }
    }
  ]
}))

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {

      case 'get_brand_context': {
        const context = await buildBrandContext(args.brand_name)
        if (!context) return { content: [{ type: 'text', text: `No brand profile found for "${args.brand_name}".` }] }
        return { content: [{ type: 'text', text: context }] }
      }

      case 'save_post_to_notion': {
        await savePost({
          text: args.text,
          brand: args.brand,
          impressions: args.impressions,
          likes: args.likes,
          retweets: args.retweets,
          notes: args.notes,
          url: args.url,
          saveReason: args.save_reason,
          postDate: args.post_date
        })
        return { content: [{ type: 'text', text: `✓ Saved to Notion: "${args.text.slice(0, 60)}..."` }] }
      }

      case 'analyze_trends': {
        const trendLimit = args.trend_limit || 20
        const postsPerTrend = args.posts_per_trend || 3

        const [trends, brandContext] = await Promise.all([
          getUSTrends(trendLimit),
          buildBrandContext(args.brand_name)
        ])

        if (!trends.length) return { content: [{ type: 'text', text: 'No trends returned from X API.' }] }
        if (!brandContext) return { content: [{ type: 'text', text: `No brand profile found for "${args.brand_name}".` }] }

        const trendPostResults = await Promise.all(
          trends.map(async (trend) => {
            try {
              const posts = await searchPosts(trend.searchQuery, postsPerTrend)
              return { trend, posts }
            } catch {
              return { trend, posts: [] }
            }
          })
        )

        const trendsFormatted = trendPostResults.map(({ trend, posts }) => {
          let block = `### ${trend.rank}. ${trend.name}`
          if (trend.tweetCount) block += ` (${trend.tweetCount.toLocaleString()} posts)`
          block += '\n'
          if (posts.length) {
            block += 'Top posts:\n'
            posts.forEach(p => {
              block += `- @${p.author} [${p.likes} likes | ${p.retweets} RTs]: "${p.text.slice(0, 120)}"\n`
            })
          }
          return block
        }).join('\n')

        const output = `# US Trends — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}\n\n` +
          `## Brand Context\n${brandContext}\n\n` +
          `## Current US Trends + Top Posts\n${trendsFormatted}\n\n---\n` +
          `Score each trend for relevance to this brand's content pillars. Rank only trends worth acting on. ` +
          `For each: (1) relevance score 1-10, (2) why it fits, (3) specific draft angle in brand voice. ` +
          `Skip anything unrelated to DeFi/crypto/trading. If nothing is relevant today, say so directly. ` +
          `End with: "Type /draft [angle] to turn any of these into a post."`

        return { content: [{ type: 'text', text: output }] }
      }

      case 'audit_x_profile': {
        const posts = await getUserPosts(args.handle, args.count || 20)
        if (!posts.length) return { content: [{ type: 'text', text: `No posts found for ${args.handle}.` }] }
        const formatted = posts.map((p, i) =>
          `${i + 1}. [${p.impressions.toLocaleString()} imp | ${p.likes} likes | ${p.retweets} RTs | ${p.replies} replies]\n"${p.text}"\n${p.url}`
        ).join('\n\n')
        return { content: [{ type: 'text', text: `${posts.length} posts from ${args.handle}:\n\n${formatted}` }] }
      }

      case 'search_x_posts': {
        const posts = await searchPosts(args.query, args.count || 20)
        if (!posts.length) return { content: [{ type: 'text', text: `No results for "${args.query}".` }] }
        const formatted = posts.map((p, i) =>
          `${i + 1}. @${p.author} [${p.impressions.toLocaleString()} imp | ${p.likes} likes | ${p.retweets} RTs]\n"${p.text}"\n${p.url}`
        ).join('\n\n')
        return { content: [{ type: 'text', text: formatted }] }
      }

      case 'get_x_post_metrics': {
        const posts = await getPostMetrics(args.post_ids)
        if (!posts.length) return { content: [{ type: 'text', text: 'No posts found for those IDs.' }] }
        const formatted = posts.map(p =>
          `"${p.text.slice(0, 100)}..."\nImpressions: ${p.impressions.toLocaleString()} | Likes: ${p.likes} | RTs: ${p.retweets} | Replies: ${p.replies}\n${p.url}`
        ).join('\n\n---\n\n')
        return { content: [{ type: 'text', text: formatted }] }
      }

      case 'create_typefully_draft': {
        const draft = await createTypefullyDraft(args.content, {
          scheduleDate: args.schedule_date,
          threadify: args.threadify || false
        })
        return {
          content: [{
            type: 'text',
            text: `✓ Draft created in Typefully${args.schedule_date ? ` — scheduled for ${args.schedule_date}` : ' — saved to queue'}.\nDraft ID: ${draft.id}`
          }]
        }
      }

      case 'get_typefully_scheduled': {
        const drafts = await getTypefullyScheduled()
        if (!drafts?.length) return { content: [{ type: 'text', text: 'No scheduled drafts in Typefully.' }] }
        const formatted = drafts.map(d =>
          `[${d.scheduled_date || 'unscheduled'}]\n"${d.text?.slice(0, 120)}..."`
        ).join('\n\n---\n\n')
        return { content: [{ type: 'text', text: formatted }] }
      }

      case 'skills': {
        return {
          content: [{
            type: 'text',
            text: `# Definitive Brain — Skills

**/morning** — Daily content briefing. Fetches US trends, scores against Definitive content pillars, returns ranked opportunities + draft angles.

**/audit @handle** — Audit any X profile. Fetches last 20 posts, flags top/bottom performers, identifies content gaps, gives 3 recommendations.

**/draft [topic]** — Generate 3 post variants in Definitive brand voice. Tag the bot in a thread to draft directly from the conversation.

**/save [post]** — Save any post to the Notion brain immediately. Works for Definitive posts or posts from other accounts.

**/schedule [post]** — Send copy directly to Typefully queue, no confirmation needed.

**/skills** — Show this menu.`
          }]
        }
      }

      case 'fetch_url': {
        // X/Twitter URLs — use the API instead of HTTP fetch (X requires JS + auth)
        const xMatch = args.url.match(/(?:twitter|x)\.com\/\w+\/status\/(\d+)/)
        if (xMatch) {
          const posts = await getPostMetrics([xMatch[1]])
          if (!posts.length) return { content: [{ type: 'text', text: `Could not fetch post from ${args.url}.` }] }
          const p = posts[0]
          return {
            content: [{
              type: 'text',
              text: `X post from ${args.url}:\n\n"${p.text}"\n\nImpressions: ${p.impressions.toLocaleString()} | Likes: ${p.likes} | RTs: ${p.retweets} | Replies: ${p.replies}`
            }]
          }
        }

        const response = await fetch(args.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DefinitiveBrain/1.0)' }
        })
        if (!response.ok) return { content: [{ type: 'text', text: `Failed to fetch ${args.url}: HTTP ${response.status}` }] }
        const html = await response.text()
        // Strip tags, collapse whitespace, trim to 8000 chars
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000)
        return { content: [{ type: 'text', text: `Content from ${args.url}:\n\n${text}` }] }
      }

      case 'get_typefully_published': {
        const posts = await getTypefullyPublished()
        if (!posts?.length) return { content: [{ type: 'text', text: 'No recently published posts found.' }] }
        const formatted = posts.map(p =>
          `[Published: ${p.published_at || 'unknown'}]\n"${p.text?.slice(0, 120)}..."`
        ).join('\n\n---\n\n')
        return { content: [{ type: 'text', text: formatted }] }
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
    }

  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
  }
})

  return server
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok', tools: 13 }))

const sessions = new Map()

app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id']
    console.log(`[mcp] ${req.method} session=${sessionId || 'none'} body=${JSON.stringify(req.body)?.slice(0, 100)}`)

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId).handleRequest(req, res, req.body)
      return
    }

    if (req.method === 'POST' && !sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { sessions.set(sid, transport) }
      })
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
      const server = createMcpServer()
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({ error: 'Send POST /mcp to start a session' })
  } catch (err) {
    console.error('MCP route error:', err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  console.error(`Definitive Brain MCP — HTTP on port ${PORT} — 12 tools loaded`)
})