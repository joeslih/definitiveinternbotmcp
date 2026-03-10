import dotenv from 'dotenv'
dotenv.config()

import http from 'node:http'
import { App } from '@slack/bolt'
import Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// ─── MCP Client ───────────────────────────────────────────────────────────────

async function createMcpClient() {
  const client = new Client(
    { name: 'definitive-brain-slackbot', version: '1.0.0' },
    { capabilities: {} }
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${process.env.MCP_SERVER_URL}/mcp`))
  )
  return client
}

async function createMcpClientWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await createMcpClient()
    } catch (err) {
      if (attempt === maxAttempts) throw err
      await new Promise(r => setTimeout(r, attempt * 1000))
    }
  }
}

// ─── Claude Tool-Use Loop ─────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Fallback used only if the MCP server prompt is unreachable
const SYSTEM_PROMPT = `You are a content strategist assistant for Definitive, a DeFi trading platform on Base and Solana.

You have access to the Definitive Brain MCP — a set of tools connected to Notion (brand knowledge), X API (real data), and Typefully (scheduling).

When the user types any of these skills, execute the corresponding workflow automatically without asking for clarification:

/morning — Call analyze_trends with brand_name "Definitive", trend_limit 20, posts_per_trend 1. Score trends against Definitive's content pillars. Return ranked opportunities with relevance score, why it fits, and a draft angle. End with "Type /draft [angle] to turn any of these into a post".

/audit [@handle] — Call audit_x_profile with the handle, count 20. Rank by impressions, flag top 3 and bottom 3, identify content gaps, give 3 actionable recommendations.

/draft [topic] — Call get_brand_context with brand_name "Definitive". Generate 3 post variants with voice rules applied. Label each variant with the approach — no rationale, no "why it fits" section, no commentary after the variants.

/save [post text] — If a URL, call get_x_post_metrics first. Infer brand from X handle, infer notes from content and metrics. Only ask user for save_reason if unclear. Call save_post_to_notion immediately. Confirm saved.

/schedule [post text] — Call create_typefully_draft immediately. If the user includes a time with a timezone, convert to UTC and pass as schedule_date. If time is given without a timezone, ask for the timezone first. Reply with only the tool's confirmation — no extra commentary.

/skills or /help — Show this skill menu.

Always on rules:
- Always call get_brand_context before drafting — never generate copy without it
- Never save to Notion without at least knowing the save_reason (Top Performer or Avoid)
- If the user asks something outside these skills, answer normally`

const TOOL_ROUTES = {
  '/morning':  ['analyze_trends', 'get_brand_context'],
  '/audit':    ['audit_x_profile'],
  '/draft':    ['get_brand_context', 'fetch_url'],
  '/save':     ['save_post_to_notion', 'get_x_post_metrics'],
  '/schedule': ['create_typefully_draft'],
  '/skills':   ['skills'],
}

async function getSystemPrompt(client) {
  try {
    const result = await client.getPrompt('definitive-brain-instructions', {})
    return result.messages[0].content.text
  } catch {
    return SYSTEM_PROMPT
  }
}

async function runClaudeWithTools(userMessage, client, allowedTools = null) {
  const [{ tools: mcpTools }, systemPrompt] = await Promise.all([
    client.listTools(),
    getSystemPrompt(client)
  ])
  const filtered = allowedTools
    ? mcpTools.filter(t => allowedTools.includes(t.name))
    : mcpTools
  const tools = filtered.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }))

  const messages = [{ role: 'user', content: userMessage }]
  const MAX_ITERATIONS = 10
  let iterations = 0

  while (iterations < MAX_ITERATIONS) {
    iterations++

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools,
      messages
    })

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use')

    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      return response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim()
    }

    const toolResults = await Promise.all(
      toolUseBlocks.map(async (toolUse) => {
        try {
          const result = await client.callTool({ name: toolUse.name, arguments: toolUse.input })
          const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          return { type: 'tool_result', tool_use_id: toolUse.id, content: text, ...(result.isError && { is_error: true }) }
        } catch (err) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: `Error: ${err.message}`, is_error: true }
        }
      })
    )

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  return 'Error: tool loop exceeded maximum iterations. Please try again.'
}

async function handleRequest(userMessage, command = null) {
  const client = await createMcpClientWithRetry()
  try {
    const allowedTools = command ? (TOOL_ROUTES[command] ?? null) : null
    return await runClaudeWithTools(userMessage, client, allowedTools)
  } finally {
    await client.close()
  }
}

// ─── Image Helpers ────────────────────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

async function fetchSlackImage(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  })
  if (!res.ok) return null
  const mediaType = res.headers.get('content-type')?.split(';')[0]
  if (!SUPPORTED_IMAGE_TYPES.includes(mediaType)) return null
  const buffer = await res.arrayBuffer()
  return { base64: Buffer.from(buffer).toString('base64'), mediaType }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPromptFromCommand(command, text) {
  const t = text?.trim() || ''
  switch (command) {
    case '/morning':   return '/morning'
    case '/audit':     return `/audit ${t}`
    case '/draft':     return `/draft ${t}`
    case '/save':      return t ? `/save ${t}` : '/save'
    case '/schedule':  return t ? `/schedule ${t}` : '/schedule'
    case '/skills':    return '/skills'
    default:           return t || command
  }
}

const CHUNK_SIZE = 2900

async function postChunked(slackClient, channel, threadTs, text) {
  if (text.length <= CHUNK_SIZE) {
    await slackClient.chat.postMessage({ channel, thread_ts: threadTs, text, mrkdwn: true })
    return
  }
  let remaining = text
  while (remaining.length > 0) {
    const boundary = remaining.length <= CHUNK_SIZE
      ? remaining.length
      : (remaining.lastIndexOf('\n', CHUNK_SIZE) > 0 ? remaining.lastIndexOf('\n', CHUNK_SIZE) : CHUNK_SIZE)
    await slackClient.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: remaining.slice(0, boundary).trimEnd(),
      mrkdwn: true
    })
    remaining = remaining.slice(boundary).trimStart()
  }
}

async function updateAndOverflow(slackClient, channel, placeholderTs, result) {
  const first = result.slice(0, CHUNK_SIZE)
  await slackClient.chat.update({ channel, ts: placeholderTs, text: first, mrkdwn: true })
  if (result.length > CHUNK_SIZE) {
    await postChunked(slackClient, channel, placeholderTs, result.slice(CHUNK_SIZE).trimStart())
  }
}

// ─── Slack App ────────────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true
})

// Slash commands
const COMMANDS = ['/morning', '/audit', '/draft', '/save', '/schedule', '/skills']

for (const command of COMMANDS) {
  app.command(command, async ({ command: cmd, ack, client }) => {
    await ack()

    const placeholder = await client.chat.postMessage({
      channel: cmd.channel_id,
      text: `_Running ${cmd.command}..._`,
      mrkdwn: true
    })

    try {
      const prompt = buildPromptFromCommand(cmd.command, cmd.text)
      const result = await handleRequest(prompt, cmd.command)
      await updateAndOverflow(client, cmd.channel_id, placeholder.ts, result)
    } catch (err) {
      await client.chat.update({
        channel: cmd.channel_id,
        ts: placeholder.ts,
        text: `Error: ${err.message}`
      })
    }
  })
}

// Fetch thread messages and format them as context for Claude
async function getThreadContext(slackClient, channel, threadTs, botUserId) {
  try {
    const response = await slackClient.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50
    })
    const messages = (response.messages || [])
      .filter(m => m.ts !== threadTs || m.text) // include parent message
      .map(m => {
        const isBot = m.bot_id || m.user === botUserId
        const sender = isBot ? 'Bot' : (m.username || m.user || 'User')
        const text = (m.text || '').replace(/<@[A-Z0-9]+>/g, '').trim()
        return text ? `${sender}: ${text}` : null
      })
      .filter(Boolean)
    return messages.length > 1 ? messages.join('\n') : null
  } catch {
    return null
  }
}

// @mentions
app.event('app_mention', async ({ event, client }) => {
  const userRequest = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
  if (!userRequest) return

  const threadTs = event.thread_ts || event.ts
  const isInThread = !!event.thread_ts

  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: '_Thinking..._',
    mrkdwn: true
  })

  try {
    let promptText = userRequest

    // If the mention is inside a thread, fetch the conversation history as context
    if (isInThread) {
      const authResponse = await client.auth.test()
      const threadContext = await getThreadContext(client, event.channel, threadTs, authResponse.user_id)
      if (threadContext) {
        promptText = `Here is the Slack thread conversation for context:\n\n${threadContext}\n\n---\n\nUser request: ${userRequest}`
      }
    }

    // Build multimodal content if images are attached
    let userContent = promptText
    const imageFiles = (event.files || []).filter(f => SUPPORTED_IMAGE_TYPES.includes(f.mimetype))
    if (imageFiles.length) {
      const images = (await Promise.all(imageFiles.map(f => fetchSlackImage(f.url_private)))).filter(Boolean)
      if (images.length) {
        userContent = [
          { type: 'text', text: promptText },
          ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } }))
        ]
      }
    }

    const command = userRequest.startsWith('/') ? userRequest.split(' ')[0] : null
    const result = await handleRequest(userContent, command)
    await updateAndOverflow(client, event.channel, placeholder.ts, result)
  } catch (err) {
    await client.chat.update({
      channel: event.channel,
      ts: placeholder.ts,
      text: `Error: ${err.message}`
    })
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────

// Minimal HTTP server so Railway health checks pass (Socket Mode doesn't bind a port)
http.createServer((_req, res) => res.end('ok')).listen(process.env.PORT || 3001)

await app.start()
console.log('Definitive Brain Slackbot running in Socket Mode')
