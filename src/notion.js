import { Client } from '@notionhq/client'

const notion = new Client({ auth: process.env.NOTION_API_KEY })

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTitle(prop) {
  return prop?.title?.[0]?.plain_text || ''
}
function getText(prop) {
  return prop?.rich_text?.[0]?.plain_text || ''
}
function getSelect(prop) {
  return prop?.select?.name || ''
}
function getNumber(prop) {
  return prop?.number || 0
}

// ─── Brand Profile ────────────────────────────────────────────────────────────

export async function getBrandProfile(brandName) {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_BRAND_PROFILES_DB,
    filter: { property: 'Name', title: { contains: brandName } }
  })
  if (!response.results.length) return null
  const props = response.results[0].properties
  return {
    name: getTitle(props.Name),
    handle: getText(props['X Handle']),
    industry: getSelect(props.Industry),
    followerCount: getNumber(props['Follower Count']),
    contentPillars: getText(props['Content Pillars']),
    audienceDescription: getText(props['Audience Description']),
    postingFrequency: getSelect(props['Posting Frequency']),
    notes: getText(props.Notes)
  }
}

// ─── Voice Rules ──────────────────────────────────────────────────────────────

export async function getVoiceRules() {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_VOICE_RULES_DB
  })
  const rules = response.results.map(page => {
    const props = page.properties
    return {
      rule: getTitle(props.Rule),
      type: getSelect(props.Type),
      description: getText(props.Description),
      correct: getText(props['Example Correct']),
      incorrect: getText(props['Example Incorrect'])
    }
  })
  return {
    dos: rules.filter(r => r.type === 'Do'),
    donts: rules.filter(r => r.type === "Don't")
  }
}

// ─── Saved Posts ──────────────────────────────────────────────────────────────

export async function getSavedPosts(saveReason) {
  const filter = saveReason
    ? { property: 'Save Reason', rich_text: { contains: saveReason } }
    : undefined

  const response = await notion.databases.query({
    database_id: process.env.NOTION_SAVED_POSTS_DB,
    filter,
    sorts: [{ property: 'Impressions', direction: 'descending' }],
    page_size: 10
  })

  return response.results.map(page => {
    const props = page.properties
    return {
      text: getTitle(props['Post Text']),
      postType: getSelect(props['Post Type']),
      impressions: getNumber(props.Impressions),
      likes: getNumber(props.Likes),
      retweets: getNumber(props.Retweets),
      whyItWorked: getText(props['Why It Worked']),
      saveReason: getText(props['Save Reason'])
    }
  })
}

// ─── Full Brand Context ───────────────────────────────────────────────────────

export async function buildBrandContext(brandName) {
  const [profile, voiceRules, topPosts, avoidPosts] = await Promise.all([
    getBrandProfile(brandName),
    getVoiceRules(),
    getSavedPosts('Top Performer'),
    getSavedPosts('Avoid')
  ])

  if (!profile) return null

  let ctx = `## Brand: ${profile.name} (${profile.handle})\n`
  ctx += `Industry: ${profile.industry} | Followers: ${profile.followerCount?.toLocaleString()}\n`
  ctx += `Content Pillars: ${profile.contentPillars}\n`
  ctx += `Audience: ${profile.audienceDescription}\n`
  if (profile.notes) ctx += `Notes: ${profile.notes}\n`

  ctx += `\n## Voice Rules\n### DO:\n`
  voiceRules.dos.forEach(r => {
    ctx += `- ${r.rule}: ${r.description}\n`
    if (r.correct) ctx += `  ✓ "${r.correct}"\n`
  })

  ctx += `\n### DON'T:\n`
  voiceRules.donts.forEach(r => {
    ctx += `- ${r.rule}: ${r.description}\n`
    if (r.incorrect) ctx += `  ✗ Avoid: "${r.incorrect}"\n`
    if (r.correct) ctx += `  ✓ Instead: "${r.correct}"\n`
  })

  if (topPosts.length) {
    ctx += `\n## Top Performing Posts\n`
    topPosts.slice(0, 3).forEach(p => {
      ctx += `---\n"${p.text}"\n`
      ctx += `${p.impressions?.toLocaleString()} impressions | ${p.likes} likes | ${p.retweets} RTs\n`
      ctx += `Why it worked: ${p.whyItWorked}\n`
    })
  }

  if (avoidPosts.length) {
    ctx += `\n## Underperforming Patterns (avoid)\n`
    avoidPosts.forEach(p => {
      ctx += `- "${p.text}" — ${p.whyItWorked}\n`
    })
  }

  return ctx
}

// ─── Save Post to Notion ──────────────────────────────────────────────────────

export async function savePost({ text, brand, postType, impressions, likes, retweets, whyItWorked, url, saveReason, postDate }) {
  await notion.pages.create({
    parent: { database_id: process.env.NOTION_SAVED_POSTS_DB },
    properties: {
      'Post Text': { title: [{ text: { content: text } }] },
      'Brand': { select: { name: brand } },
      'Post Type': { rich_text: [{ text: { content: postType || '' } }] },
      'Impressions': { number: impressions || 0 },
      'Likes': { number: likes || 0 },
      'Retweets': { number: retweets || 0 },
      'Why It Worked': { rich_text: [{ text: { content: whyItWorked || '' } }] },
      'URL': { rich_text: [{ text: { content: url || '' } }] },
      'Save Reason': { rich_text: [{ text: { content: saveReason || 'Reference' } }] },
      ...(postDate && { 'Date': { date: { start: postDate } } })
    }
  })
  return true
}
