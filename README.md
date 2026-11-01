# Mulqi Websearch

One DeepSeek Harness web plugin replacing four: `dsh-free-search`, `@liustack/modsearch`, `dsh-web-monid`, and `dsh-web-monid-fallback`.

## Why

Those four bundles each registered their own provider with `ctx.web`. The seam can only select one id, so at most one of them was ever used and the rest sat idle. This plugin registers **one** search provider and **one** fetch provider that front every backend behind a round-robin ring with bounded fallback.

## Providers

| Id | Kind | Backends |
|---|---|---|
| `mulqi-websearch` | search | ddg, ddg-lite, bing, searxng, anysearch, exa-mcp, keenable, tavily, exa, tinyfish, firecrawl, monid, perplexity, deepseek-official, modsearch |
| `mulqi-fetch` | fetch | direct HTTP fetch, then modsearch page reader |

## How the rotation works

- Every search **starts at the next engine** in the ring (`cursor++`), so load spreads instead of hammering engine #1.
- A failing engine gets an **exponential cooldown** (30s doubling to 10min) and is retried later — never dropped.
- Inside one call the scheduler walks healthy engines, then cooling ones, bounded by `maxAttempts` (default 6).
- `timeRange` puts time-capable engines first; non-capable ones stay as a last resort.
- An explicit `engine` argument is tried first, then the ring still falls back on failure.
- Abort wins: no fallback attempt runs after `signal.aborted`.

## Tools

| Tool | Purpose |
|---|---|
| `advanced_search` | Search via the ring; `timeRange`, `maxResults`, `engine` |
| `free_search_test` | Probe every backend, report health and cooldowns |
| `platform_search` | github, v2ex, bilibili, reddit, hn, stackoverflow, wikipedia, npm |
| `x_search` | X/Twitter posts via the modsearch bridge |
| `read_page` | Read one URL into summary + content + links |

The core `web_search` / `web_fetch` tools route through the same providers.

## Config

```yaml
- id: mulqi-websearch
  config:
    maxAttempts: 6
    cooldownBaseMs: 30000
    cooldownMaxMs: 600000
    region: us-en
    bingMarket: en-US
    lang: en
    safeSearch: moderate
    modsearchCli: /path/to/modsearch/dist/main.js
    maxBodyChars: 200000
    keys:
      TINYFISH_API_KEY: "..."
```

API keys resolve in order: `config.keys`, process env, launch environment. A key-gated engine without its key is skipped locally (no network call, no cooldown penalty).

## Layout

```
lib/backends.js   backend descriptors + private engines + CLI bridge
lib/scheduler.js  round-robin ring, cooldowns, fallback, abort
lib/index.js      plugin: providers + tools
cordis.patch.yml  bundle patch (provider ids + tool-web enable)
```
