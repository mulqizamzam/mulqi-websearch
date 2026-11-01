/**
 * Mulqi Websearch - one DeepSeek Harness web plugin replacing four.
 *
 * Before: dsh-free-search + @liustack/modsearch + dsh-web-monid +
 * dsh-web-monid-fallback each registered their own provider with ctx.web, so
 * the seam had to be pinned to a single id and the rest sat idle.
 *
 * After: ONE search provider (`mulqi-websearch`) fronts every engine behind a
 * round-robin ring with bounded fallback, and ONE fetch provider
 * (`mulqi-fetch`) fronts HTTP fetch + the modsearch page reader. The public
 * tools (advanced_search, free_search_test, platform_search, x_search,
 * read_page) and the core web_search / web_fetch tools all route through them.
 *
 * Rotation rule: every call starts at the next engine in the ring, so load is
 * spread; a failing engine gets an exponential cooldown and is retried later,
 * never dropped. Inside one call the scheduler walks healthy then cooling,
 * bounded by maxAttempts, with an explicit `engine` always tried first.
 */
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

import {
  BACKENDS,
  BACKEND_IDS,
  parseTimeRange,
  searchPlatform,
  PLATFORMS,
  modsearchReadPage,
  modsearchXSearch,
} from './backends.js'
import { RoundRobinScheduler } from './scheduler.js'

/** Platform ids are the keys of the PLATFORMS map (github, v2ex, ...). */
const PLATFORM_IDS = Object.keys(PLATFORMS)

export const name = 'mulqi-websearch'
export const inject = ['web']

const SEARCH_PROVIDER_ID = 'mulqi-websearch'
const FETCH_PROVIDER_ID = 'mulqi-fetch'
const DEFAULT_MAX_BODY_CHARS = 200_000
const TOOL_TIMEOUT_MS = 120_000
const TEST_TIMEOUT_MS = 25_000

/** Keys this plugin may need, resolved from config, process env, then launch env. */
const KEY_NAMES = [
  'TINYFISH_API_KEY',
  'FIRECRAWL_API_KEY',
  'MONID_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'KEENABLE_API_KEY',
  'PERPLEXITY_API_KEY',
  'DEEPSEEK_API_KEY',
]

function resolveKeys(ctx, overrides) {
  // The launch environment is the third key source (config > process env >
  // launch env). It is optional: a context without that service still works.
  let env = null
  try {
    env = launchEnvironmentOf(ctx)
  } catch {
    env = null
  }
  const keys = {}
  for (const keyName of KEY_NAMES) {
    const fromConfig = overrides ? overrides[keyName] : undefined
    const fromEnv = process.env[keyName]
    let fromLaunch
    if (env && typeof env.get === 'function') {
      try {
        const launchEntry = env.get(keyName)
        fromLaunch = launchEntry ? launchEntry.value : undefined
      } catch {
        fromLaunch = undefined
      }
    }
    const value = fromConfig ?? fromEnv ?? fromLaunch ?? ''
    keys[keyName] = typeof value === 'string' ? value : String(value)
  }
  return keys
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error(label + ' timed out after ' + ms + 'ms'))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(function () {
    clearTimeout(timer)
  })
}

/** Fetch one URL with the platform fetch, decoded into the seam body union. */
async function httpFetch(url, signal, maxBodyChars) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported URL scheme: ' + parsed.protocol)
  }
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; mulqi-websearch/1.0)',
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
    },
    signal,
  })
  const contentType = response.headers.get('content-type') || ''
  const raw = await response.text()
  const limit = typeof maxBodyChars === 'number' && maxBodyChars > 0 ? maxBodyChars : DEFAULT_MAX_BODY_CHARS
  const truncated = raw.length > limit
  return {
    url: response.url || url,
    statusCode: response.status,
    body: { kind: /html/i.test(contentType) ? 'html' : 'text', content: truncated ? raw.slice(0, limit) : raw },
    truncated,
  }
}

/** Truncate sources to the request bound, flagging the cut like the seam does. */
function capSources(result, maxResults) {
  if (typeof maxResults !== 'number' || maxResults <= 0) return result
  if (result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }
}

/**
 * Strip undefined recursively. The tool runtime rejects an output value that is
 * not lossless JSON, and `{ content: undefined }` is exactly that failure.
 */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const entry = clean(value[key])
      if (entry !== undefined) out[key] = entry
    }
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return undefined
  return value
}

function textRender(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function renderSearch(_args, value) {
  const lines = []
  if (value && value.content) lines.push(String(value.content), '')
  if (value && value.backend) lines.push('engine: ' + value.backend)
  const sources = value && Array.isArray(value.sources) ? value.sources : []
  sources.forEach(function (source, index) {
    lines.push(index + 1 + '. ' + (source.title || source.url))
    lines.push('   ' + source.url)
    if (source.snippet) lines.push('   ' + source.snippet)
  })
  if (value && value.truncated) lines.push('(truncated to maxResults)')
  if (value && Array.isArray(value.attempts)) {
    const failed = value.attempts.filter(function (attempt) { return attempt.ok === false })
    if (failed.length > 0) {
      lines.push('fell back past: ' + failed.map(function (attempt) { return attempt.backend }).join(', '))
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx, config = {}) {
  const keys = resolveKeys(ctx, config.keys)
  const options = {
    region: config.region,
    lang: config.lang,
    bingMarket: config.bingMarket,
    safeSearch: config.safeSearch,
    searxngInstances: config.searxngInstances,
    modsearchCli: config.modsearchCli,
    maxBodyChars: config.maxBodyChars,
  }
  const scheduler = new RoundRobinScheduler(BACKENDS, {
    maxAttempts: config.maxAttempts,
    cooldownBaseMs: config.cooldownBaseMs,
    cooldownMaxMs: config.cooldownMaxMs,
  })

  function buildRequest(args) {
    const query = args && args.query
    if (typeof query !== 'string' || query.trim() === '') throw new Error('query is required')
    const request = { query: query.trim() }
    if (typeof args.maxResults === 'number' && args.maxResults > 0) {
      request.maxResults = Math.min(Math.floor(args.maxResults), 10)
    }
    if (typeof args.timeRange === 'string' && args.timeRange.trim() !== '') {
      request.timeRange = args.timeRange.trim()
      request.timeParsed = parseTimeRange(request.timeRange)
    }
    if (typeof args.engine === 'string' && BACKEND_IDS.indexOf(args.engine) >= 0) {
      request.engine = args.engine
    }
    return request
  }

  const searchProvider = {
    id: SEARCH_PROVIDER_ID,
    available: function () { return true },
    async search(request, signal) {
      const outcome = await scheduler.search(request, keys, options, signal)
      return capSources(outcome.result, request.maxResults)
    },
  }

  const fetchProvider = {
    id: FETCH_PROVIDER_ID,
    available: function () { return true },
    async fetch(request, signal) {
      const failures = []
      try {
        return await httpFetch(request.url, signal, options.maxBodyChars)
      } catch (error) {
        if (signal && signal.aborted) throw error
        failures.push('http: ' + (error && error.message ? error.message : String(error)))
      }
      try {
        const page = await modsearchReadPage(request.url, undefined, { options }, signal)
        const content = page.content && page.content.length > 0 ? page.content : page.summary
        if (!content) throw new Error('empty page evidence')
        return {
          url: request.url,
          statusCode: 200,
          body: { kind: 'text', content: content.slice(0, options.maxBodyChars || DEFAULT_MAX_BODY_CHARS) },
          truncated: content.length > (options.maxBodyChars || DEFAULT_MAX_BODY_CHARS),
        }
      } catch (error) {
        if (signal && signal.aborted) throw error
        failures.push('read_page: ' + (error && error.message ? error.message : String(error)))
      }
      throw new Error('mulqi-fetch could not retrieve ' + request.url + ' - ' + failures.join(' | '))
    },
  }

  ctx.effect(function () {
    return ctx.web.registerSearchProvider(searchProvider)
  }, 'mulqi-websearch: search provider')

  ctx.effect(function () {
    return ctx.web.registerFetchProvider(fetchProvider)
  }, 'mulqi-websearch: fetch provider')

  ctx.inject(['tools'], function (sctx) {
    sctx.effect(function () {
      return sctx.tools.register({
        name: 'advanced_search',
        description:
          'Search the web through Mulqi Websearch: a round-robin ring over DuckDuckGo, Bing, SearXNG, AnySearch, Exa, Tavily, Keenable, TinyFish, Firecrawl, Monid, Perplexity, DeepSeek and the modsearch bridge. Failed engines fall back automatically. Use timeRange for a specific window and engine to force one backend.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            maxResults: { type: 'number', description: 'Result count (default 5, max 10).' },
            timeRange: {
              type: 'string',
              description: 'Optional window: day, week, month, year, or 12h, 3d, 2mo, 1y, or an absolute date like 2026-07-01.',
            },
            engine: {
              type: 'string',
              enum: BACKEND_IDS,
              description: 'Force one backend id; the ring still falls back on failure.',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderSearch },
        timeoutMs: TOOL_TIMEOUT_MS,
        isConcurrencySafe: function () { return true },
        async execute(args, exec) {
          const request = buildRequest(args)
          const outcome = await scheduler.search(request, keys, options, exec.signal)
          return clean({
            ok: true,
            backend: outcome.backend,
            content: outcome.result.content,
            sources: outcome.result.sources,
            truncated: outcome.result.truncated,
            attempts: outcome.attempts,
          })
        },
      })
    }, 'mulqi-websearch: advanced_search')
  })

  ctx.inject(['tools'], function (sctx) {
    sctx.effect(function () {
      return sctx.tools.register({
        name: 'free_search_test',
        description:
          'Probe every Mulqi Websearch backend and report which ones answer right now, including cooldown state and missing API keys.',
        parameters: {
          type: 'object',
          properties: {
            engines: {
              type: 'array',
              items: { type: 'string', enum: BACKEND_IDS },
              description: 'Subset of backend ids to probe (default: all).',
            },
            query: { type: 'string', description: 'Probe query (default: DeepSeek Harness).' },
          },
          additionalProperties: false,
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
        timeoutMs: TOOL_TIMEOUT_MS,
        isConcurrencySafe: function () { return true },
        async execute(args, exec) {
          const query = args && typeof args.query === 'string' && args.query.trim() !== ''
            ? args.query.trim()
            : 'DeepSeek Harness'
          const wanted = args && Array.isArray(args.engines) && args.engines.length > 0
            ? args.engines
            : BACKEND_IDS
          const targets = BACKENDS.filter(function (backend) {
            return wanted.indexOf(backend.id) >= 0
          })
          const results = []
          for (const backend of targets) {
            if (backend.key && !keys[backend.key]) {
              results.push({ id: backend.id, ok: false, error: backend.key + ' is not configured' })
              continue
            }
            const startedAt = Date.now()
            try {
              const raw = await withTimeout(
                Promise.resolve().then(function () {
                  return backend.run(query, 3, { keys, options }, exec.signal)
                }),
                Math.min(backend.timeoutMs, TEST_TIMEOUT_MS),
                backend.id,
              )
              results.push({
                id: backend.id,
                ok: Array.isArray(raw && raw.sources) && raw.sources.length > 0,
                ms: Date.now() - startedAt,
                sources: Array.isArray(raw && raw.sources) ? raw.sources.length : 0,
              })
            } catch (error) {
              results.push({
                id: backend.id,
                ok: false,
                ms: Date.now() - startedAt,
                error: (error && error.message ? error.message : String(error)).slice(0, 200),
              })
            }
          }
          return clean({
            query,
            ok: results.filter(function (r) { return r.ok }).length,
            total: results.length,
            results,
            health: scheduler.snapshot(keys),
          })
        },
      })
    }, 'mulqi-websearch: free_search_test')
  })

  ctx.inject(['tools'], function (sctx) {
    sctx.effect(function () {
      return sctx.tools.register({
        name: 'platform_search',
        description:
          'Search one platform for a query: github, v2ex, bilibili, reddit, hn, stackoverflow, wikipedia or npm. Returns source URLs with titles and snippets.',
        parameters: {
          type: 'object',
          properties: {
            platform: { type: 'string', enum: PLATFORM_IDS, description: 'Platform to search.' },
            query: { type: 'string', description: 'The search query.' },
            maxResults: { type: 'number', description: 'Result count (default 5, max 10).' },
          },
          required: ['platform', 'query'],
          additionalProperties: false,
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: renderSearch },
        timeoutMs: TOOL_TIMEOUT_MS,
        isConcurrencySafe: function () { return true },
        async execute(args, exec) {
          if (typeof args.platform !== 'string' || PLATFORM_IDS.indexOf(args.platform) < 0) {
            throw new Error('platform must be one of: ' + PLATFORM_IDS.join(', '))
          }
          if (typeof args.query !== 'string' || args.query.trim() === '') {
            throw new Error('query is required')
          }
          const limit = typeof args.maxResults === 'number' && args.maxResults > 0
            ? Math.min(Math.floor(args.maxResults), 10)
            : 5
          const raw = await searchPlatform(args.platform, args.query.trim(), limit, exec.signal, options.lang)
          return clean({
            ok: true,
            platform: args.platform,
            backend: 'platform:' + args.platform,
            sources: raw.sources || [],
            truncated: raw.truncated === true,
          })
        },
      })
    }, 'mulqi-websearch: platform_search')
  })

  ctx.inject(['tools'], function (sctx) {
    sctx.effect(function () {
      return sctx.tools.register({
        name: 'x_search',
        description:
          'Search X (Twitter) posts through the modsearch bridge. Returns a summary, per-post items with URLs, and an uncertainty list.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for on X.' },
            max_results: { type: 'number', description: 'Maximum result items (default 8).' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
        timeoutMs: TOOL_TIMEOUT_MS,
        isConcurrencySafe: function () { return true },
        async execute(args, exec) {
          if (typeof args.query !== 'string' || args.query.trim() === '') {
            throw new Error('x_search needs a non-empty query')
          }
          const limit = typeof args.max_results === 'number' && args.max_results > 0
            ? Math.floor(args.max_results)
            : 8
          return clean(await modsearchXSearch(args.query.trim(), limit, { options }, exec.signal))
        },
      })
    }, 'mulqi-websearch: x_search')
  })

  ctx.inject(['tools'], function (sctx) {
    sctx.effect(function () {
      return sctx.tools.register({
        name: 'read_page',
        description:
          'Read one web page through the modsearch bridge: a summary, extracted content, outgoing links, uncertainty and operational warnings. Pass query to focus the reading.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The http(s) URL to read.' },
            query: { type: 'string', description: 'Optional question to focus the reading on.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: textRender },
        timeoutMs: TOOL_TIMEOUT_MS,
        isConcurrencySafe: function () { return true },
        async execute(args, exec) {
          if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url.trim())) {
            throw new Error('read_page needs an http(s) url')
          }
          return clean(await modsearchReadPage(args.url.trim(), args.query, { options }, exec.signal))
        },
      })
    }, 'mulqi-websearch: read_page')
  })
}

export { SEARCH_PROVIDER_ID, FETCH_PROVIDER_ID }
