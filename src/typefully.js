// Typefully API client (v2)
// Docs: https://typefully.com/docs/api
// Base URL: https://api.typefully.com/v2

const TYPEFULLY_BASE = 'https://api.typefully.com/v2'

function headers() {
  return {
    'Authorization': `Bearer ${process.env.TYPEFULLY_API_KEY}`,
    'Content-Type': 'application/json'
  }
}

// ─── Get Social Set ID ────────────────────────────────────────────────────────
// v2 requires a social_set_id for all draft operations. We fetch the first one.

async function getSocialSetId() {
  const res = await fetch(`${TYPEFULLY_BASE}/social-sets`, { headers: headers() })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Typefully API error ${res.status}: ${err}`)
  }
  const data = await res.json()
  const first = data.results?.[0]
  if (!first) throw new Error('No social sets found in Typefully account.')
  return first.id
}

// ─── Create a Draft ───────────────────────────────────────────────────────────
// content: string (use \n\n to split into thread tweets)
// options: { scheduleDate, threadify }

export async function createTypefullyDraft(content, options = {}) {
  const socialSetId = await getSocialSetId()

  // Split into thread posts if threadify or \n\n present
  const posts = options.threadify
    ? content.split('\n\n').filter(Boolean).map(text => ({ text }))
    : [{ text: content }]

  const body = {
    platforms: {
      x: {
        enabled: true,
        posts
      }
    }
  }

  if (options.scheduleDate) {
    body.publish_at = options.scheduleDate
  }

  const res = await fetch(`${TYPEFULLY_BASE}/social-sets/${socialSetId}/drafts`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Typefully API error ${res.status}: ${err}`)
  }

  return res.json()
}

// ─── Get Scheduled Drafts ─────────────────────────────────────────────────────

export async function getTypefullyScheduled() {
  const socialSetId = await getSocialSetId()

  const res = await fetch(
    `${TYPEFULLY_BASE}/social-sets/${socialSetId}/drafts?status=scheduled`,
    { headers: headers() }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Typefully API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.results || []
}

// ─── Get Recently Published ───────────────────────────────────────────────────

export async function getTypefullyPublished() {
  const socialSetId = await getSocialSetId()

  const res = await fetch(
    `${TYPEFULLY_BASE}/social-sets/${socialSetId}/drafts?status=published`,
    { headers: headers() }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Typefully API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.results || []
}
