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
import { buildBrandContext, getBrandProfile, getSavedPosts, savePost } from './notion.js'
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

const INSTRUCTIONS = `You are a content strategist assistant for Definitive, a DeFi trading platform on Base and Solana.

You have access to the Definitive Brain MCP — tools connected to Notion (brand knowledge), X API (real data), and Typefully (scheduling).

## Slash Command Routing

Any message that starts with / is a skill invocation. Match it to the skill below and execute immediately without asking for clarification. Do not treat it as a question or conversation — just run the skill.

Examples:
- "/skills" → show the skill menu
- "/morning" → run the morning briefing
- "/audit @DefinitiveFi" → audit that profile
- "/draft leaderboard update" → draft posts about that topic

## Skills

When the user types any of these, execute the corresponding workflow automatically without asking for clarification:

---

**/morning**
Run the daily content intelligence briefing.
1. Call \`analyze_trends\` with brand_name "Definitive", trend_limit 20, posts_per_trend 3
2. Score every trend against Definitive's content pillars
3. Return: ranked opportunities (relevance score + why it fits + specific draft angle), and a clear "skip" list for irrelevant trends
4. End with: "Type /draft [angle] to turn any of these into a post"

---

**/audit [@handle]**
Audit any X profile's recent content.
1. Call \`audit_x_profile\` with the provided handle, count 20
2. Categorize posts by type (Leaderboard Drama, CTA, Community, Educational, etc.)
3. Rank by impressions — flag top 3 and bottom 3 with explanation
4. Identify content gaps and over-reliance on any single format
5. Give 3 specific actionable recommendations

---

**/draft [topic or angle]**
Generate post copy in Definitive's brand voice.
1. Call \`get_brand_context\` with brand_name "Definitive"
2. Call \`get_saved_posts\` with save_reason "Top Performer" for reference examples
3. Generate 3 post variants following all voice rules
4. Label each variant with its approach (e.g. "Leaderboard Drama", "Stat-led", "Challenge")
5. Ask: "Want me to send one of these to Typefully?"

---

**/save [post text]**
Save a post or finding to the Notion brain.
1. Ask for: brand, post type, impressions/likes/RTs if known, why it worked, save reason
2. Call \`save_post_to_notion\` with those details
3. Confirm saved

---

**/schedule [post text]**
Send copy directly to Typefully.
1. Confirm the copy with the user before sending
2. Ask if they want to schedule a specific time or save to queue
3. Call \`create_typefully_draft\` with the content and optional schedule_date
4. Confirm draft created

---

**/queue**
Show what's currently scheduled in Typefully.
1. Call \`get_typefully_scheduled\`
2. Display scheduled posts in chronological order
3. Note any gaps or clustering

---

**/skills** or **/help**
List all available skills with a one-line description of each.

---

## Always-on rules
- Always call \`get_brand_context\` before drafting — never generate copy without it
- Never send to Typefully without explicit user confirmation
- Never save to Notion without confirming the details first
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
      description: 'Load full brand context from Notion — profile, voice rules, top posts, patterns to avoid. Always call this before drafting.',
      inputSchema: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Brand name e.g. "Definitive"' }
        },
        required: ['brand_name']
      }
    },
    {
      name: 'get_brand_profile',
      description: 'Get basic profile info for a brand — handle, followers, pillars, audience.',
      inputSchema: {
        type: 'object',
        properties: {
          brand_name: { type: 'string' }
        },
        required: ['brand_name']
      }
    },
    {
      name: 'get_saved_posts',
      description: 'Retrieve saved posts from Notion filtered by save reason. Use to find examples before drafting.',
      inputSchema: {
        type: 'object',
        properties: {
          save_reason: {
            type: 'string',
            enum: ['Top Performer', 'Avoid', 'Reference', 'Voice Example']
          }
        }
      }
    },
    {
      name: 'save_post_to_notion',
      description: 'Save a post or finding to Notion for future reference.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          brand: { type: 'string' },
          post_type: { type: 'string', description: 'Leaderboard Drama, Educational, CTA, Community, Prize Update, AMA' },
          impressions: { type: 'number' },
          likes: { type: 'number' },
          retweets: { type: 'number' },
          why_it_worked: { type: 'string' },
          url: { type: 'string' },
          save_reason: {
            type: 'string',
            enum: ['Top Performer', 'Avoid', 'Reference', 'Voice Example']
          },
          post_date: { type: 'string', description: 'ISO 8601 date the post was published e.g. "2026-02-24"' }
        },
        required: ['text', 'brand', 'save_reason']
      }
    },

    // ── X API ─────────────────────────────────────────────────────────────────

    {
      name: 'analyze_trends',
      description: 'Morning content intelligence tool. Fetches current US trending topics from X, pulls top posts for each relevant trend, then scores every trend against the brand\'s content pillars and returns ranked opportunities with suggested draft angles. Run this daily before planning content.',
      inputSchema: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Brand to score trends against e.g. "Definitive"' },
          trend_limit: { type: 'number', description: 'How many US trends to fetch. Default 20.' },
          posts_per_trend: { type: 'number', description: 'Top posts to fetch per trend. Default 3.' }
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
          count: { type: 'number', description: 'Number of posts to fetch. Default 20, max 100.' }
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
      description: 'Get current engagement metrics for specific post IDs.',
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
      description: 'Send approved post copy to Typefully as a draft. Only call after the user confirms they are happy with the copy.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Post content. Use \\n\\n between thread tweets.' },
          schedule_date: { type: 'string', description: 'ISO 8601 datetime e.g. "2026-03-01T09:00:00Z". Leave empty to save to queue.' },
          threadify: { type: 'boolean', description: 'Auto-split into thread. Default false.' }
        },
        required: ['content']
      }
    },
    {
      name: 'get_typefully_scheduled',
      description: 'Get all scheduled drafts in Typefully. Check before creating posts to avoid duplicate topics.',
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

      case 'get_brand_profile': {
        const profile = await getBrandProfile(args.brand_name)
        if (!profile) return { content: [{ type: 'text', text: `No profile found for "${args.brand_name}".` }] }
        return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] }
      }

      case 'get_saved_posts': {
        const posts = await getSavedPosts(args.save_reason)
        if (!posts.length) return { content: [{ type: 'text', text: 'No posts found.' }] }
        const formatted = posts.map(p =>
          `[${p.postType} | ${p.impressions?.toLocaleString()} impressions | ${p.likes} likes]\n"${p.text}"\nWhy it worked: ${p.whyItWorked}`
        ).join('\n\n---\n\n')
        return { content: [{ type: 'text', text: formatted }] }
      }

      case 'save_post_to_notion': {
        await savePost({
          text: args.text,
          brand: args.brand,
          postType: args.post_type,
          impressions: args.impressions,
          likes: args.likes,
          retweets: args.retweets,
          whyItWorked: args.why_it_worked,
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

**/audit @handle** — Audit any X profile. Fetches last 20 posts, categorizes by type, flags top/bottom performers, gives 3 recommendations.

**/draft [topic]** — Generate 3 post variants in Definitive brand voice. Loads brand context + top performer examples from Notion automatically.

**/save [post]** — Save a post or finding to the Notion brain.

**/schedule [post]** — Send copy to Typefully after confirmation. Add \`| date:2026-03-01T09:00:00Z\` to schedule a specific time.

**/queue** — Show what's currently scheduled in Typefully.

**/skills** — Show this menu.`
          }]
        }
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

app.get('/health', (_req, res) => res.json({ status: 'ok', tools: 12 }))

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