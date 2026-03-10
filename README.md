# Definitive Brain — MCP Server

A Claude desktop MCP that connects to Notion (brand knowledge), X API (real data), and Typefully (scheduling). Gives your team a consistent set of skills for daily content work — no copy-pasting, no context re-explaining, no switching tabs.

---

## Skills

Type any of these in Claude desktop:

| Skill | What it does |
|-------|-------------|
| `/morning` | Fetches US trends from X, scores each against Definitive's content pillars, returns ranked opportunities with draft angles |
| `/audit @handle` | Fetches last 20 posts from any X profile, categorizes by type, flags top/bottom performers, gives 3 recommendations |
| `/draft [topic]` | Loads brand context + top performer examples from Notion, generates 3 post variants in Definitive's voice |
| `/save [post]` | Saves a post or finding to the Notion brain |
| `/schedule [post]` | Sends approved copy to Typefully after confirmation |
| `/queue` | Shows what's currently scheduled in Typefully |
| `/skills` or `/help` | Shows this skill menu |

---

## How it works

Each skill maps to one or more MCP tools. Claude calls them automatically — you never reference tool names directly.

**11 tools across 3 integrations:**

**Notion (4 tools)**
- `get_brand_context` — loads full brand profile, voice rules, top posts, patterns to avoid
- `get_brand_profile` — lightweight profile lookup
- `get_saved_posts` — pulls examples filtered by Top Performer / Avoid / Reference
- `save_post_to_notion` — writes findings back to Notion mid-conversation

**X API (4 tools)**
- `analyze_trends` — fetches US trends + top posts per trend, used by `/morning`
- `audit_x_profile` — fetches last N posts from any profile with full metrics, used by `/audit`
- `search_x_posts` — searches posts by keyword, hashtag, or account
- `get_x_post_metrics` — fetches current metrics for specific post IDs

**Typefully (3 tools)**
- `create_typefully_draft` — pushes copy to Typefully queue or schedules it
- `get_typefully_scheduled` — returns all scheduled drafts
- `get_typefully_published` — returns recently published posts

---

## Setup

### 1. Install dependencies

```bash
cd definitive-brain-mcp
npm install
```

### 2. Get your credentials

You need 3 sets of keys:

**Notion API key**
- Go to notion.so/profile/integrations → Internal integrations → Create new
- Name it `Definitive Brain`, select the Definitive workspace
- Copy the `secret_...` token
- In each of the 4 Notion databases: click **...** → **Connections** → add the integration

**X Bearer Token**
- Go to developer.x.com → Developer Console → your app → Keys and Tokens
- Copy the Bearer Token (read-only access to public data, no OAuth needed)
- X API is pay-per-use — `/morning` costs a few cents per run

**Typefully API key**
- Go to typefully.com → Settings → API → Generate key

### 3. Get your Notion database IDs

Open each database in Notion. The URL looks like:
```
https://www.notion.so/definitiveco/31268aedf6f28048b772e4509ab22c4d?v=...
```
The database ID is the 32-char string before the `?`: `31268aedf6f28048b772e4509ab22c4d`

You need IDs for all 4 databases: Brand Profiles, Voice Rules, Saved Posts, Skills.

### 4. Configure Claude desktop

Find your config file:
- **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Copy the contents of `claude_desktop_config.json` from this repo into that file. Replace all placeholder values with your real keys and database IDs. Replace `/absolute/path/to/` with the actual path to this repo on your machine.

### 5. Restart Claude desktop

Fully quit and reopen. You should see a 🔧 icon in the chat input indicating MCP tools are available.

### 6. Test it

Type `/skills` — Claude should print the full skill menu.
Type `/morning` — Claude will fetch US trends, score them, and return today's content opportunities.

---

## Sharing with your team

Each team member needs to:
1. Clone this repo
2. Run `npm install`
3. Add `claude_desktop_config.json` to their own Claude desktop config with the shared credentials
4. Restart Claude desktop

No server, no hosting, no Slack admin approval needed. Everyone gets the same skills pointing at the same Notion brain.

---

## Adding more brands

Add a new row to the Brand Profiles table in Notion and add corresponding voice rules. No code changes needed. Then use `/draft` with the new brand name and Claude will load the right context automatically.

---

## Project structure

```
definitive-brain-mcp/
├── src/
│   ├── index.js        # MCP server — 11 tool definitions and handlers
│   ├── notion.js       # Notion API — reads and writes brand brain
│   ├── x.js            # X API — trends, profile audits, search, metrics
│   └── typefully.js    # Typefully API — drafts and scheduling
├── system_prompt.md    # Readable version of the Claude desktop system prompt
├── claude_desktop_config.json  # Drop this into your Claude desktop config
├── .env.example        # All environment variables
├── package.json
└── README.md
```

---

## Environment variables

```
NOTION_API_KEY=secret_...
NOTION_BRAND_PROFILES_DB=32_char_id
NOTION_VOICE_RULES_DB=32_char_id
NOTION_SAVED_POSTS_DB=32_char_id

TYPEFULLY_API_KEY=...

X_BEARER_TOKEN=...
```
