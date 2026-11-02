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

### SearXNG is special

Public SearXNG instances mostly refuse the JSON API now. Probed from this host,
every default instance answered with `403`, `429`, an anti-bot HTML page
("Verifying your browser...", "Making sure you're not a bot!"), or `200 text/html`
with the JSON API disabled — **zero** returned usable JSON.

Walking six of those at the upstream 8s-per-instance timeout cost ~48s of the
ring's time on one dead engine. `searxng` therefore has its own walker:

- 6s per instance, 12s for the whole attempt (bounded, not 6 × 8s).
- `403`/`429` and anti-bot bodies mark an instance **dead for 10 minutes**, so
  later calls skip it instead of re-paying for it.
- `classifySearxngResponse()` is exported and pure, so every shape that occurs
  in the wild is covered by a test without touching the network.

The engine is still registered and still attempted — it just no longer
dominates a call. Point `searxngInstances` at instances you control to make it
useful.

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
    searxngInstances: ["https://your-searxng.example"]
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

## Installation

This plugin is a DSH **bundle**, not a plain npm dependency. DSH reads
`dsh.profile.bundles` at startup, so a restart is required after wiring it in.

### 1. Place the plugin

```bash
git clone https://github.com/mulqizamzam/mulqi-websearch.git \
  /path/to/dsh-custom/plugins/mulqi-websearch
```

### 2. Give the plugin its own module resolution

Node resolves bare specifiers from the **real path** of the importing file, not
from the symlink inside the profile. The plugin therefore needs a `node_modules`
of its own pointing at the packages it imports:

```bash
cd /path/to/dsh-custom/plugins/mulqi-websearch
mkdir -p node_modules/@deepseek-ai

PROFILE=/path/to/.dsh/profiles/web/node_modules

# engine library: 11 of the 15 backends below are reused from it
ln -sfn /path/to/dsh-custom/plugins/dsh-free-search-chain node_modules/dsh-free-search

# DSH core packages used by the plugin
for p in dsh-launch-environment dsh-tools schemastery dsh-web cordis; do
  ln -sfn "$PROFILE/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
```

### 3. Register it in the profile

In `.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "mulqi-websearch": "link:/path/to/dsh-custom/plugins/mulqi-websearch"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "mulqi-websearch"]
    }
  }
}
```

Remove any bundle this plugin replaces: `dsh-free-search`,
`@liustack/modsearch`, `dsh-web-monid`, `dsh-web-monid-fallback`.

Then make the package resolvable from the profile:

```bash
cd .dsh/profiles/web
ln -sfn /path/to/dsh-custom/plugins/mulqi-websearch node_modules/mulqi-websearch
```

### 4. Pin the providers

In `.dsh/profiles/web/cordis.patch.yml`. A profile-level row **replaces the
whole config**, so state both keys explicitly:

```yaml
- id: web
  config:
    searchProvider: mulqi-websearch
    fetchProvider: mulqi-fetch
  disabled: false
```

### 5. Restart

```bash
# stop the running server, then
pnpm dsh web --no-open
```

Verify the plugin loaded:

```
free_search_test                      # probes every backend, reports health
advanced_search query:"..." engine:"bing"
```

## Testing

```bash
npm run verify      # syntax check + regression suite
npm test            # regression suite only (7 tests)
```

The suite locks two production bugs: a tool output carrying `undefined`
(rejected as "not lossless JSON") and `PLATFORMS` being used as an array
when it is an object map.

## License

MIT — see [LICENSE](./LICENSE).
