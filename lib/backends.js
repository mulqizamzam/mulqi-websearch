/**
 * Backend adapters for Mulqi Websearch.
 *
 * Every backend is a plain descriptor:
 *   { id, label, group, time, key, timeoutMs, run(query, maxResults, ctx, signal) }
 *
 * `ctx` carries per-request context: { keys, timeParsed, timeRange, options }.
 * A backend resolves to a WebSearchResult-shaped object ({ content?, sources,
 * truncated }) or throws; the scheduler owns retries and cooldowns.
 *
 * Engine implementations are REUSED from dsh-free-search (linked, not copied)
 * so an upstream fix lands here too. The three engines that package keeps
 * private (tinyfish, firecrawl, monid) are implemented locally below with the
 * same request/response contract. modsearch is reused through its own CLI,
 * exactly as @liustack/modsearch's DSH plugin invokes it.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import {
  searchBing,
  searchDdgHtml,
  searchDdgLite,
  searchAnysearch,
  searchExaMCP,
  searchExa,
  searchTavily,
  searchKeenable,
  searchPerplexity,
  searchDeepSeekOfficial,
  searchPlatform,
  parseTimeRange,
  PLATFORMS,
  SEARXNG_INSTANCES,
  approximateTimeRange,
  resolveTimeRangeDays,
  uniqueSources,
} from 'dsh-free-search'

export { parseTimeRange, searchPlatform, PLATFORMS }

/** Default CLI entry of @liustack/modsearch (the profile install). */
export const DEFAULT_MODSEARCH_CLI =
  '/home/administrator/agent-workspace/.dsh/profiles/web/node_modules/@liustack/modsearch/dist/main.js'

/** Run one child process, collecting stdout/stderr, honoring an AbortSignal. */
function runChild(command, args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

/* ------------------------------------------------------------------ */
/* Engines whose implementations dsh-free-search keeps private         */
/* ------------------------------------------------------------------ */

/** TinyFish Search API: GET https://api.search.tinyfish.ai (x-api-key). */
async function tinyfishSearch(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error('TinyFish requires TINYFISH_API_KEY')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  let response
  try {
    response = await fetch(`https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        'user-agent': 'mulqi-websearch/1.0',
      },
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`TinyFish request failed: ${error?.message ?? String(error)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = body?.error?.message ?? body?.message ?? ''
    } catch { /* body was not JSON */ }
    throw new Error(`TinyFish API error (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = await response.json()
  const results = Array.isArray(data?.results) ? data.results : []
  return {
    sources: results
      .filter((item) => item && item.url)
      .slice(0, maxResults ?? 10)
      .map((item) => ({
        url: String(item.url),
        ...(item.title ? { title: String(item.title) } : {}),
        ...(item.snippet ? { snippet: String(item.snippet).slice(0, 300) } : {}),
        ...(item.date ? { publishedAt: String(item.date) } : {}),
      })),
    truncated: false,
  }
}

/** Firecrawl Search API: POST https://api.firecrawl.dev/v1/search (Bearer). */
async function firecrawlSearch(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error('Firecrawl requires FIRECRAWL_API_KEY')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  let response
  try {
    response = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, limit: Math.min(Math.max(maxResults ?? 5, 1), 10) }),
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`Firecrawl request failed: ${error?.message ?? String(error)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = body?.error ?? body?.message ?? ''
    } catch { /* body was not JSON */ }
    throw new Error(`Firecrawl API error (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = await response.json()
  if (data?.success === false) throw new Error(`Firecrawl API error: ${data.error ?? 'unknown'}`)
  const results = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.data?.web) ? data.data.web : [])
  return {
    sources: results
      .filter((item) => item && item.url)
      .map((item) => ({
        url: String(item.url),
        ...(item.title ? { title: String(item.title) } : {}),
        ...(item.description ? { snippet: String(item.description).slice(0, 300) } : {}),
      })),
    truncated: false,
  }
}

/** MONID gateway: POST https://api.monid.ai/v1/run -> Octen /search. */
async function monidSearch(query, maxResults, apiKey, signal) {
  if (!apiKey) throw new Error('Monid requires MONID_API_KEY')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  let response
  try {
    response = await fetch('https://api.monid.ai/v1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        provider: 'octen',
        endpoint: '/search',
        input: { body: { query, count: Math.min(Math.max(maxResults ?? 5, 1), 10) } },
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error(`Monid request failed: ${error?.message ?? String(error)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = body?.error?.message ?? body?.message ?? ''
    } catch { /* body was not JSON */ }
    throw new Error(`Monid API error (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = await response.json()
  if (data?.status && data.status !== 'COMPLETED') {
    throw new Error(`Monid run status ${data.status}${data.error?.message ? `: ${data.error.message}` : ''}`)
  }
  const results = Array.isArray(data?.output?.data?.results) ? data.output.data.results : []
  return {
    sources: results
      .filter((item) => item && item.url)
      .map((item) => ({
        url: String(item.url),
        ...(item.title ? { title: String(item.title) } : {}),
        ...(item.highlight ? { snippet: String(item.highlight).slice(0, 300) } : {}),
      })),
    truncated: false,
  }
}

/* ------------------------------------------------------------------ */
/* CLI bridge engines                                                  */
/* ------------------------------------------------------------------ */

/** modsearch CLI search (`--source web`). Returns normalized sources. */
async function modsearchSearch(query, maxResults, ctx, signal) {
  const cli = ctx.options.modsearchCli || DEFAULT_MODSEARCH_CLI
  if (!existsSync(cli)) throw new Error(`modsearch CLI not found at ${cli}`)
  const args = ['-q', query, '--source', 'web', '--timeout', '40000', '--deadline', '55000']
  if (typeof maxResults === 'number' && maxResults > 0) args.push('--max-results', String(Math.floor(maxResults)))
  const { code, stdout, stderr } = await runChild(process.execPath, [cli, ...args], signal, 70_000)
  if (code !== 0) throw new Error(`modsearch exit ${code}: ${(stderr || stdout).trim().slice(0, 300)}`)
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(`modsearch produced no JSON: ${stdout.trim().slice(0, 200)}`)
  }
  const entry = Array.isArray(parsed?.results) ? parsed.results[0] : undefined
  if (!entry || typeof entry.summary !== 'string') throw new Error('modsearch envelope without a usable entry')
  if (entry.status === 'unavailable') {
    const trail = (Array.isArray(entry.attempts) ? entry.attempts : [])
      .map((attempt) => `${attempt.engine}: ${attempt.error ?? 'skipped'}`)
      .join('; ')
    throw new Error(`modsearch could not reach the web${trail ? ` (${trail.slice(0, 300)})` : ''}`)
  }
  const sources = (Array.isArray(entry.items) ? entry.items : [])
    .filter((item) => item && typeof item.url === 'string')
    .map((item) => ({
      url: item.url,
      ...(item.title ? { title: String(item.title) } : {}),
      ...(item.snippet ? { snippet: String(item.snippet).slice(0, 400) } : {}),
      ...(item.published_at ? { publishedAt: String(item.published_at) } : {}),
    }))
  if (sources.length === 0) throw new Error('modsearch returned no sources')
  return { content: entry.summary, sources, truncated: false }
}

/** modsearch CLI page read (`-u <url>`), used as the fetch fallback. */
export async function modsearchReadPage(url, query, ctx, signal) {
  const cli = ctx.options.modsearchCli || DEFAULT_MODSEARCH_CLI
  if (!existsSync(cli)) throw new Error(`modsearch CLI not found at ${cli}`)
  const args = ['-u', url, '--timeout', '40000', '--deadline', '55000']
  if (typeof query === 'string' && query.trim() !== '') args.push('-q', query)
  const { code, stdout, stderr } = await runChild(process.execPath, [cli, ...args], signal, 70_000)
  if (code !== 0) throw new Error(`modsearch read exit ${code}: ${(stderr || stdout).trim().slice(0, 300)}`)
  const parsed = JSON.parse(stdout)
  const entry = Array.isArray(parsed?.results) ? parsed.results[0] : undefined
  if (!entry) throw new Error('modsearch read returned an empty envelope')
  return {
    summary: String(entry.summary ?? ''),
    content: String(entry.content ?? ''),
    links: Array.isArray(entry.links) ? entry.links : [],
    uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
    warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
  }
}

/** modsearch CLI X/Twitter search (`--source x`). */
export async function modsearchXSearch(query, maxResults, ctx, signal) {
  const cli = ctx.options.modsearchCli || DEFAULT_MODSEARCH_CLI
  if (!existsSync(cli)) throw new Error(`modsearch CLI not found at ${cli}`)
  const args = ['-q', query, '--source', 'x', '--timeout', '40000', '--deadline', '55000']
  if (typeof maxResults === 'number' && maxResults > 0) args.push('--max-results', String(Math.floor(maxResults)))
  const { code, stdout, stderr } = await runChild(process.execPath, [cli, ...args], signal, 70_000)
  if (code !== 0) throw new Error(`modsearch x exit ${code}: ${(stderr || stdout).trim().slice(0, 300)}`)
  const parsed = JSON.parse(stdout)
  const entry = Array.isArray(parsed?.results) ? parsed.results[0] : undefined
  if (!entry || typeof entry.summary !== 'string') throw new Error('modsearch x envelope without a usable entry')
  return {
    summary: entry.summary,
    items: (Array.isArray(entry.items) ? entry.items : []).filter((item) => item && typeof item.url === 'string'),
    uncertainty: Array.isArray(entry.uncertainty) ? entry.uncertainty : [],
    status: entry.status === 'degraded' ? 'degraded' : 'ok',
  }
}

/* ------------------------------------------------------------------ */
/* SearXNG: bounded instance walk with dead-instance memory            */
/* ------------------------------------------------------------------ */

/**
 * Public SearXNG instances increasingly refuse the JSON API: they answer 403
 * or 429, or return 200 with an anti-bot HTML page ("Verifying your browser...",
 * "Making sure you're not a bot!", "Security check"). None of those carry
 * results, and walking six of them at the upstream 8s timeout spends ~48s of
 * the ring's time on one dead engine before the scheduler can cool it down.
 *
 * This walker bounds the whole attempt, recognises the anti-bot bodies, and
 * remembers an instance that refused so later calls skip it for a while.
 */
const SEARXNG_INSTANCE_TIMEOUT_MS = 6_000
const SEARXNG_TOTAL_BUDGET_MS = 12_000
const SEARXNG_DEAD_MS = 10 * 60_000
const SEARXNG_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Time-window values the SearXNG JSON API accepts. */
const SEARXNG_TIME = { day: 'day', week: 'week', month: 'month', year: 'year' }

/** Base URL -> epoch ms until which this instance is skipped. */
const searxngDead = new Map()

const SEARXNG_ANTI_BOT =
  /captcha|just a moment|checking your browser|verifying your browser|making sure you.{0,3}re not a bot|security check|not a bot/i

/**
 * Classify one SearXNG response. Pure, so every shape that actually occurs in
 * the wild -- JSON results, JSON with zero results, 403/429, anti-bot HTML,
 * plain HTML with the JSON API disabled -- is testable without a network.
 *
 * `dead` means "do not retry this instance for a while": it refused the API
 * outright rather than merely having nothing for this query.
 */
export function classifySearxngResponse(status, contentType, body) {
  if (status === 403 || status === 429) {
    return { ok: false, dead: true, reason: 'HTTP ' + status }
  }
  if (status < 200 || status >= 300) {
    return { ok: false, dead: false, reason: 'HTTP ' + status }
  }
  const text = typeof body === 'string' ? body : ''
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (parsed && Array.isArray(parsed.results)) {
    const sources = parsed.results
      .filter((entry) => entry && typeof entry.url === 'string' && entry.url.length > 0)
      .map((entry) => ({
        url: entry.url,
        ...(entry.title ? { title: String(entry.title) } : {}),
        ...(entry.content ? { snippet: String(entry.content) } : {}),
      }))
    if (sources.length === 0) return { ok: false, dead: false, sources, reason: '0 results' }
    return { ok: true, dead: false, sources, reason: 'ok' }
  }
  if (SEARXNG_ANTI_BOT.test(text)) {
    return { ok: false, dead: true, reason: 'anti-bot page' }
  }
  return {
    ok: false,
    dead: false,
    reason: 'JSON API disabled (got ' + (contentType || 'unknown') + ')',
  }
}

async function fetchSearxngInstance(base, query, timeRange, signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, timeoutMs)
  const onAbort = function () { controller.abort() }
  signal?.addEventListener('abort', onAbort)
  try {
    const params = new URLSearchParams({ q: query, format: 'json' })
    if (timeRange) params.set('time_range', timeRange)
    const response = await fetch(base + '/search?' + params.toString(), {
      headers: { 'user-agent': SEARXNG_UA, accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await response.text()
    return classifySearxngResponse(response.status, response.headers.get('content-type'), body)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Walk the SearXNG instances inside one wall-clock budget. Instances on
 * dead-cooldown are tried only as a last resort, so a recovered instance is
 * still discovered without paying for it on every call.
 */
export async function searxngSearch(query, maxResults, ctx, signal) {
  const configured = ctx.options.searxngInstances
  const instances = Array.isArray(configured) && configured.length > 0 ? configured : SEARXNG_INSTANCES
  if (instances.length === 0) throw new Error('searxng: no instances configured')

  let timeRange
  if (ctx.timeParsed) {
    const days = resolveTimeRangeDays(ctx.timeParsed) ?? 7
    timeRange = SEARXNG_TIME[approximateTimeRange(days)]
  }

  const now = Date.now()
  const live = instances.filter((base) => (searxngDead.get(base) ?? 0) <= now)
  const cooling = instances.filter((base) => (searxngDead.get(base) ?? 0) > now)

  const startedAt = Date.now()
  const errors = []
  for (const base of live.concat(cooling)) {
    const remaining = SEARXNG_TOTAL_BUDGET_MS - (Date.now() - startedAt)
    if (remaining <= 0) {
      errors.push(base + ': instance budget exhausted')
      continue
    }
    let outcome
    try {
      outcome = await fetchSearxngInstance(
        base,
        query,
        timeRange,
        signal,
        Math.min(SEARXNG_INSTANCE_TIMEOUT_MS, remaining),
      )
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push(base + ': ' + (error && error.message ? error.message : String(error)))
      continue
    }
    if (outcome.ok) {
      searxngDead.delete(base)
      return { sources: uniqueSources(outcome.sources, maxResults ?? 10), truncated: false }
    }
    if (outcome.dead) searxngDead.set(base, Date.now() + SEARXNG_DEAD_MS)
    errors.push(base + ': ' + outcome.reason)
  }
  throw new Error('all SearXNG instances failed: ' + errors.join('; '))
}

/* ------------------------------------------------------------------ */
/* The round-robin ring                                                */
/* ------------------------------------------------------------------ */

/**
 * Keyless, fast engines first; key-gated ones next; the subprocess bridge
 * last. `time: true` means the engine honors a time window natively.
 */
export const BACKENDS = [
  {
    id: 'ddg', label: 'DuckDuckGo HTML', group: 'free', time: true, timeoutMs: 15_000,
    run: (q, n, ctx, signal) => searchDdgHtml(q, n, {
      region: ctx.options.region,
      safeSearch: ctx.options.safeSearch,
      timeRange: ctx.timeParsed,
      lang: ctx.options.lang,
    }, signal),
  },
  {
    id: 'ddg-lite', label: 'DuckDuckGo Lite', group: 'free', time: true, timeoutMs: 15_000,
    run: (q, n, ctx, signal) => searchDdgLite(q, n, {
      safeSearch: ctx.options.safeSearch,
      timeRange: ctx.timeParsed,
    }, signal),
  },
  {
    id: 'bing', label: 'Bing', group: 'free', time: true, timeoutMs: 15_000,
    run: (q, n, ctx, signal) => searchBing(q, n, {
      bingMarket: ctx.options.bingMarket,
      safeSearch: ctx.options.safeSearch,
      timeRange: ctx.timeParsed,
      lang: ctx.options.lang,
    }, signal),
  },
  {
    id: 'searxng', label: 'SearXNG (public instances, often anti-bot)', group: 'free', time: true, timeoutMs: 20_000,
    run: (q, n, ctx, signal) => searxngSearch(q, n, ctx, signal),
  },
  {
    id: 'anysearch', label: 'AnySearch', group: 'free', time: false, timeoutMs: 15_000,
    run: (q, n, ctx, signal) => searchAnysearch(q, n, signal),
  },
  {
    id: 'exa-mcp', label: 'Exa (anonymous MCP)', group: 'free', time: false, timeoutMs: 25_000,
    run: (q, n, ctx, signal) => searchExaMCP(q, n, signal),
  },
  {
    id: 'keenable', label: 'Keenable (keyless MCP / REST)', group: 'keyless-or-key', time: true, timeoutMs: 30_000,
    run: (q, n, ctx, signal) => searchKeenable(q, n, ctx.keys.KEENABLE_API_KEY, ctx.timeParsed, signal),
  },
  {
    id: 'tavily', label: 'Tavily', group: 'paid', time: true, key: 'TAVILY_API_KEY', timeoutMs: 25_000,
    run: (q, n, ctx, signal) => searchTavily(q, n, ctx.keys.TAVILY_API_KEY, ctx.timeParsed, signal),
  },
  {
    id: 'exa', label: 'Exa', group: 'paid', time: true, key: 'EXA_API_KEY', timeoutMs: 25_000,
    run: (q, n, ctx, signal) => searchExa(q, n, ctx.keys.EXA_API_KEY, ctx.timeParsed, signal),
  },
  {
    id: 'tinyfish', label: 'TinyFish', group: 'paid', time: false, key: 'TINYFISH_API_KEY', timeoutMs: 20_000,
    run: (q, n, ctx, signal) => tinyfishSearch(q, n, ctx.keys.TINYFISH_API_KEY, signal),
  },
  {
    id: 'firecrawl', label: 'Firecrawl', group: 'paid', time: false, key: 'FIRECRAWL_API_KEY', timeoutMs: 25_000,
    run: (q, n, ctx, signal) => firecrawlSearch(q, n, ctx.keys.FIRECRAWL_API_KEY, signal),
  },
  {
    id: 'monid', label: 'Monid (Octen /search)', group: 'paid', time: false, key: 'MONID_API_KEY', timeoutMs: 35_000,
    run: (q, n, ctx, signal) => monidSearch(q, n, ctx.keys.MONID_API_KEY, signal),
  },
  {
    id: 'perplexity', label: 'Perplexity', group: 'paid', time: false, key: 'PERPLEXITY_API_KEY', timeoutMs: 40_000,
    run: (q, n, ctx, signal) => searchPerplexity(q, n, ctx.keys.PERPLEXITY_API_KEY, signal),
  },
  {
    id: 'deepseek-official', label: 'DeepSeek official search', group: 'paid', time: false, key: 'DEEPSEEK_API_KEY', timeoutMs: 25_000,
    run: (q, n, ctx, signal) => searchDeepSeekOfficial(q, n, ctx.keys.DEEPSEEK_API_KEY, signal),
  },
  {
    id: 'modsearch', label: 'modsearch CLI', group: 'bridge', time: false, timeoutMs: 75_000,
    run: (q, n, ctx, signal) => modsearchSearch(q, n, ctx, signal),
  },
]

export const BACKEND_IDS = BACKENDS.map((backend) => backend.id)

/** Normalize any backend payload to the seam's WebSearchResult shape. */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('backend returned no result')
  const sources = (Array.isArray(raw.sources) ? raw.sources : [])
    .filter((source) => source && typeof source.url === 'string' && source.url.length > 0)
    .map((source) => ({
      url: source.url,
      ...(source.title ? { title: String(source.title) } : {}),
      ...(source.snippet ? { snippet: String(source.snippet) } : {}),
      ...(source.publishedAt ? { publishedAt: String(source.publishedAt) } : {}),
    }))
  if (sources.length === 0) throw new Error('backend returned zero usable sources')
  return {
    ...(typeof raw.content === 'string' && raw.content.trim() !== '' ? { content: raw.content } : {}),
    sources,
    truncated: raw.truncated === true,
  }
}
