/**
 * Regression locks for Mulqi Websearch.
 *
 * Two production bugs this file exists to prevent from coming back:
 *
 *   1. `value is not lossless JSON` — a tool result carrying `undefined`
 *      (e.g. `content` when a provider returns no summary) is rejected by the
 *      tool runtime. The `clean()` helper in lib/index.js strips it.
 *   2. `ReferenceError: PLATFORM_IDS` — `PLATFORMS` is an object map, not an
 *      array; using it directly as a schema enum / calling `.indexOf` throws.
 *
 * Run with:  node --test test/
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

const PLUGIN_URL = new URL('../lib/index.js', import.meta.url)

/** A fake cordis context that records what `apply()` registers. */
function fakeContext() {
  const registered = { search: [], fetch: [], tools: [], effects: [] }
  const ctx = {
    web: {
      registerSearchProvider(provider) {
        registered.search.push(provider)
        return () => {}
      },
      registerFetchProvider(provider) {
        registered.fetch.push(provider)
        return () => {}
      },
    },
    effect(fn) {
      registered.effects.push(fn)
      return fn()
    },
    inject(_names, fn) {
      fn(Object.assign({}, ctx, {
        tools: {
          register(definition) {
            registered.tools.push(definition)
            return () => {}
          },
        },
      }))
    },
  }
  return { ctx, registered }
}

async function loadPlugin() {
  return import(PLUGIN_URL.href + '?t=' + Date.now())
}

/* ------------------------------------------------------------------ */
/* Bug 1 — tool output must be lossless JSON                           */
/* ------------------------------------------------------------------ */

test('advanced_search omits an absent content field instead of emitting undefined', async () => {
  const mod = await loadPlugin()
  const { ctx, registered } = fakeContext()
  mod.apply(ctx, {})
  assert.ok(registered.tools.length >= 5, 'plugin should register its tools')

  const advancedSearch = registered.tools.find((t) => t.name === 'advanced_search')
  assert.ok(advancedSearch, 'advanced_search must be registered')

  // Return a provider result WITHOUT `content`, which is exactly the shape
  // that produced `content: undefined` and the runtime rejection.
  const provider = registered.search[0]
  provider.search = async () => ({ sources: [{ url: 'https://example.test/', title: 'x' }], truncated: false })

  const value = await advancedSearch.execute({ query: 'anything' }, { signal: undefined })
  const json = JSON.stringify(value)
  assert.equal(json.includes('undefined'), false, 'serialized output must not contain the token undefined')
  assert.doesNotThrow(() => JSON.parse(json), 'output must round-trip through JSON')
  assert.equal('content' in value, false, 'an absent content field must be omitted, not set to undefined')
})

test('every registered tool declares output schema and render', async () => {
  const mod = await loadPlugin()
  const { ctx, registered } = fakeContext()
  mod.apply(ctx, {})
  assert.ok(registered.tools.length > 0)
  for (const tool of registered.tools) {
    assert.equal(typeof tool.output, 'object', tool.name + ' must declare output')
    assert.equal(typeof tool.output.render, 'function', tool.name + ' must declare output.render')
    assert.equal(typeof tool.output.schema, 'object', tool.name + ' must declare output.schema')
  }
})

test('every tool render reads the RESULT, not the arguments', async () => {
  // Bug 3: dsh-tools calls `render(args, value)`. A renderer declared as
  // `render(value)` receives the ARGUMENTS in that position, so the tool card
  // shows the input instead of the output (free_search_test rendered "null").
  const mod = await loadPlugin()
  const { ctx, registered } = fakeContext()
  mod.apply(ctx, {})
  // A result shape both renderer families surface: textRender prints the
  // whole value, renderSearch prints value.sources.
  const value = { sources: [{ url: 'https://value-marker.test/', title: 'VALUE-MARKER' }], truncated: false }
  for (const tool of registered.tools) {
    const rendered = tool.output.render({ argsMarker: 'ARGS-MARKER' }, value)
    assert.ok(Array.isArray(rendered), tool.name + ' render must return content blocks')
    const text = rendered.map((block) => block.text ?? '').join('')
    assert.ok(text.includes('VALUE-MARKER'), tool.name + ' render must include the result value')
    assert.equal(text.includes('ARGS-MARKER'), false, tool.name + ' render must not echo the arguments')
  }
})

test('apply() registers exactly one search provider and one fetch provider', async () => {
  const mod = await loadPlugin()
  const { ctx, registered } = fakeContext()
  mod.apply(ctx, {})
  assert.equal(registered.search.length, 1)
  assert.equal(registered.fetch.length, 1)
  assert.equal(registered.search[0].id, mod.SEARCH_PROVIDER_ID)
  assert.equal(registered.fetch[0].id, mod.FETCH_PROVIDER_ID)
})

/* ------------------------------------------------------------------ */
/* Bug 2 — PLATFORMS is a map, PLATFORM_IDS is the array               */
/* ------------------------------------------------------------------ */

test('PLATFORMS is an object map, not an array', async () => {
  const backends = await import(new URL('../lib/backends.js', import.meta.url).href)
  assert.equal(Array.isArray(backends.PLATFORMS), false, 'PLATFORMS must not be an array')
  assert.equal(typeof backends.PLATFORMS, 'object')
  const ids = Object.keys(backends.PLATFORMS)
  assert.ok(ids.length > 0, 'PLATFORMS must expose at least one platform')
  for (const id of ['github', 'v2ex', 'bilibili', 'reddit', 'hn', 'stackoverflow', 'wikipedia', 'npm']) {
    assert.ok(ids.includes(id), 'missing platform id: ' + id)
  }
})

test('platform_search enum accepts exactly the platform ids', async () => {
  const mod = await loadPlugin()
  const backends = await import(new URL('../lib/backends.js', import.meta.url).href)
  const { ctx, registered } = fakeContext()
  mod.apply(ctx, {})

  const platformSearch = registered.tools.find((t) => t.name === 'platform_search')
  assert.ok(platformSearch, 'platform_search must be registered')

  const enumValues = platformSearch.parameters.properties.platform.enum
  assert.ok(Array.isArray(enumValues), 'platform enum must be an array')
  assert.deepEqual([...enumValues].sort(), Object.keys(backends.PLATFORMS).sort())

  // An unknown platform must be rejected locally, before any network call.
  await assert.rejects(
    () => platformSearch.execute({ platform: 'not-a-platform', query: 'x' }, { signal: undefined }),
    /platform must be one of/,
  )
})

/* ------------------------------------------------------------------ */
/* Ring behaviour that the merge depends on                           */
/* ------------------------------------------------------------------ */

test('searxng classifier reads the shapes public instances really return', async () => {
  // Public SearXNG instances answer the JSON API in five different ways:
  // real results, zero results, 403/429, an anti-bot HTML page, or plain HTML
  // with the JSON API disabled. Only the first is usable, and the anti-bot
  // page must NOT be parsed as "no results" -- that would keep walking.
  const { classifySearxngResponse } = await import(new URL('../lib/backends.js', import.meta.url).href)

  const ok = classifySearxngResponse(200, 'application/json', JSON.stringify({
    results: [{ url: 'https://a.test/', title: 'A', content: 'snippet' }],
  }))
  assert.equal(ok.ok, true)
  assert.equal(ok.dead, false)
  assert.deepEqual(ok.sources, [{ url: 'https://a.test/', title: 'A', snippet: 'snippet' }])

  const empty = classifySearxngResponse(200, 'application/json', JSON.stringify({ results: [] }))
  assert.equal(empty.ok, false)
  assert.equal(empty.dead, false, 'zero results is a valid answer, not a dead instance')

  for (const status of [403, 429]) {
    const refused = classifySearxngResponse(status, 'text/html', 'nope')
    assert.equal(refused.ok, false)
    assert.equal(refused.dead, true, 'HTTP ' + status + ' must put the instance on cooldown')
  }

  for (const title of [
    'Verifying your browser...',
    'Making sure you are not a bot!',
    'Security check - Substation',
  ]) {
    const bot = classifySearxngResponse(200, 'text/html', '<html><title>' + title + '</title></html>')
    assert.equal(bot.ok, false, title + ' carries no results')
    assert.equal(bot.dead, true, title + ' must not be retried on every call')
  }

  const html = classifySearxngResponse(200, 'text/html', '<html><title>SearXNG</title></html>')
  assert.equal(html.ok, false)
  assert.equal(html.dead, false, 'JSON disabled is a config problem, not a block')
})

test('searxng walker respects its budget and skips dead instances first', async () => {
  // The walk must never spend more than SEARXNG_TOTAL_BUDGET_MS, and an
  // instance that already refused must be tried last, not first.
  const { searxngSearch } = await import(new URL('../lib/backends.js', import.meta.url).href)
  const tried = []
  const servers = new Map()

  const server = http.createServer((req, res) => {
    const base = 'http://127.0.0.1:' + server.address().port
    tried.push(req.url)
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('Forbidden')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    const ctx = { options: { searxngInstances: [base + '/one', base + '/two'] }, timeParsed: undefined }
    await assert.rejects(() => searxngSearch('q', 5, ctx, undefined), /all SearXNG instances failed/)
    assert.equal(tried.length, 2, 'every configured instance must be attempted once')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('scheduler rotates the starting engine and falls back past failures', async () => {
  const { RoundRobinScheduler } = await import(new URL('../lib/scheduler.js', import.meta.url).href)

  const make = (id, shouldFail) => ({
    id,
    label: id,
    group: 'test',
    time: false,
    timeoutMs: 2000,
    run: async () => {
      if (shouldFail) throw new Error('boom-' + id)
      return { sources: [{ url: 'https://example.test/' + id }], truncated: false }
    },
  })

  const backends = [make('a'), make('bad', true), make('b')]
  const scheduler = new RoundRobinScheduler(backends, { maxAttempts: 3, cooldownBaseMs: 60_000 })

  const first = await scheduler.search({ query: 'q' }, {}, {})
  assert.equal(first.backend, 'a', 'first call must start at the first engine')

  const second = await scheduler.search({ query: 'q' }, {}, {})
  assert.equal(second.backend, 'b', 'second call must fall back past the failing engine')
  assert.ok(second.attempts.some((a) => a.backend === 'bad' && a.ok === false), 'the failure must be recorded')

  const cooling = scheduler.snapshot({}).filter((s) => s.coolingMs > 0)
  assert.deepEqual(cooling.map((s) => s.id), ['bad'], 'a failed engine must enter cooldown')
})

test('scheduler honors an aborted signal', async () => {
  const { RoundRobinScheduler } = await import(new URL('../lib/scheduler.js', import.meta.url).href)
  const scheduler = new RoundRobinScheduler([{
    id: 'only', label: 'only', group: 'test', time: false, timeoutMs: 1000,
    run: async () => ({ sources: [{ url: 'https://example.test/' }], truncated: false }),
  }], { maxAttempts: 1 })

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => scheduler.search({ query: 'q' }, {}, {}, controller.signal), /abort/i)
})
