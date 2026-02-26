// X API v2 client
// Docs: https://docs.x.com/x-api
// Auth: Bearer token (app-only) for reading public data
// Pay-per-use: credits deducted per request in Developer Console

const X_BASE = 'https://api.x.com/2'

function headers() {
  return {
    'Authorization': `Bearer ${process.env.X_BEARER_TOKEN}`,
    'Content-Type': 'application/json'
  }
}

// ─── Get User by Handle ───────────────────────────────────────────────────────

export async function getUserByHandle(handle) {
  const username = handle.replace('@', '')
  const params = new URLSearchParams({
    'user.fields': 'public_metrics,description,created_at,verified'
  })

  const res = await fetch(`${X_BASE}/users/by/username/${username}?${params}`, {
    headers: headers()
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`X API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.data
}

// ─── Get Last N Posts from a User ────────────────────────────────────────────
// This is the core of the /audit tool
// Returns posts with full public metrics

export async function getUserPosts(handle, count = 20) {
  const user = await getUserByHandle(handle)
  if (!user) throw new Error(`User not found: ${handle}`)

  const params = new URLSearchParams({
    max_results: Math.min(count, 100),
    'tweet.fields': 'public_metrics,created_at,text,entities',
    exclude: 'retweets,replies' // original posts only
  })

  const res = await fetch(`${X_BASE}/users/${user.id}/tweets?${params}`, {
    headers: headers()
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`X API error ${res.status}: ${err}`)
  }

  const data = await res.json()

  // Shape each post into a clean object for Claude to analyze
  return (data.data || []).map(post => ({
    id: post.id,
    text: post.text,
    createdAt: post.created_at,
    impressions: post.public_metrics?.impression_count || 0,
    likes: post.public_metrics?.like_count || 0,
    retweets: post.public_metrics?.retweet_count || 0,
    replies: post.public_metrics?.reply_count || 0,
    quotes: post.public_metrics?.quote_count || 0,
    bookmarks: post.public_metrics?.bookmark_count || 0,
    url: `https://x.com/${handle.replace('@', '')}/status/${post.id}`
  }))
}

// ─── Search Posts ─────────────────────────────────────────────────────────────
// Search recent posts by keyword, hashtag, or from a specific account

export async function searchPosts(query, count = 20) {
  const params = new URLSearchParams({
    query,
    max_results: Math.min(count, 100),
    'tweet.fields': 'public_metrics,created_at,text,author_id',
    expansions: 'author_id',
    'user.fields': 'username,name'
  })

  const res = await fetch(`${X_BASE}/tweets/search/recent?${params}`, {
    headers: headers()
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`X API error ${res.status}: ${err}`)
  }

  const data = await res.json()

  // Build a lookup of user info
  const users = {}
  if (data.includes?.users) {
    data.includes.users.forEach(u => { users[u.id] = u })
  }

  return (data.data || []).map(post => ({
    id: post.id,
    text: post.text,
    createdAt: post.created_at,
    author: users[post.author_id]?.username || post.author_id,
    impressions: post.public_metrics?.impression_count || 0,
    likes: post.public_metrics?.like_count || 0,
    retweets: post.public_metrics?.retweet_count || 0,
    replies: post.public_metrics?.reply_count || 0,
    url: `https://x.com/${users[post.author_id]?.username}/status/${post.id}`
  }))
}

// ─── Get US Trends ────────────────────────────────────────────────────────────
// Docs: https://docs.x.com/x-api/trends/trends-by-woeid/introduction
// WOEID 23424977 = United States
// Returns trending topics with tweet volumes — no query params supported

export async function getUSTrends(limit = 20) {
  const US_WOEID = 23424977

  const res = await fetch(`${X_BASE}/trends/by/woeid/${US_WOEID}`, {
    headers: headers()
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`X API trends error ${res.status}: ${err}`)
  }

  const data = await res.json()

  return (data.data || []).slice(0, limit).map((t, i) => ({
    rank: i + 1,
    name: t.trend_name,
    tweetCount: t.tweet_count || null,
    searchQuery: t.trend_name
  }))
}

// ─── Get Your Own Post Metrics ────────────────────────────────────────────────
// Fetches metrics for specific post IDs — useful for checking perf on drafts you've already posted

export async function getPostMetrics(postIds) {
  const ids = Array.isArray(postIds) ? postIds.join(',') : postIds
  const params = new URLSearchParams({
    ids,
    'tweet.fields': 'public_metrics,created_at,text'
  })

  const res = await fetch(`${X_BASE}/tweets?${params}`, {
    headers: headers()
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`X API error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return (data.data || []).map(post => ({
    id: post.id,
    text: post.text,
    createdAt: post.created_at,
    impressions: post.public_metrics?.impression_count || 0,
    likes: post.public_metrics?.like_count || 0,
    retweets: post.public_metrics?.retweet_count || 0,
    replies: post.public_metrics?.reply_count || 0,
    url: `https://x.com/i/status/${post.id}`
  }))
}
