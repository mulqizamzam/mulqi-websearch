/**
 * Round-robin scheduler with bounded fallback and per-backend cooldown.
 *
 * Contract:
 *  - Every call STARTS at the next backend in the ring (`cursor++`), so load is
 *    spread across engines instead of always hammering the first one.
 *  - A failed backend is put on an exponential cooldown and moved behind the
 *    healthy ones for later calls — it is never removed, so it comes back.
 *  - Within one call the scheduler walks healthy → cooling → (optionally) the
 *    caller's explicit `engine`, bounded by `maxAttempts`.
 *  - An explicit `request.engine` is tried first, then the ring falls back.
 *  - A `timeRange` puts time-capable engines first and, when at least one is
 *    usable, keeps non-capable engines only as a last resort.
 *  - Abort always wins: no fallback attempt runs after `signal.aborted`.
 */
import { normalizeResult } from './backends.js'

const COOLDOWN_BASE_MS = 30_000
const COOLDOWN_MAX_MS = 10 * 60_000

function rotate(list, start) {
  if (list.length === 0) return []
  const offset = ((start % list.length) + list.length) % list.length
  return [...list.slice(offset), ...list.slice(0, offset)]
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class RoundRobinScheduler {
  constructor(backends, options = {}) {
    this.backends = backends
    this.options = {
      maxAttempts: options.maxAttempts ?? Math.min(backends.length, 6),
      cooldownBaseMs: options.cooldownBaseMs ?? COOLDOWN_BASE_MS,
      cooldownMaxMs: options.cooldownMaxMs ?? COOLDOWN_MAX_MS,
      respectCooldown: options.respectCooldown !== false,
    }
    this.cursor = 0
    this.health = new Map() // id -> { failures, until, lastError, lastOkAt, lastMs }
  }

  /** Cheap local usability test — a key-gated backend without its key is skipped. */
  isUsable(backend, keys) {
    if (!backend.key) return true
    const value = keys?.[backend.key]
    return typeof value === 'string' && value.length > 0
  }

  isCooling(id, now = Date.now()) {
    const state = this.health.get(id)
    return Boolean(state && state.until > now)
  }

  state(id) {
    let state = this.health.get(id)
    if (!state) {
      state = { failures: 0, until: 0, lastError: undefined, lastOkAt: undefined, lastMs: undefined }
      this.health.set(id, state)
    }
    return state
  }

  markOk(id, ms) {
    const state = this.state(id)
    state.failures = 0
    state.until = 0
    state.lastError = undefined
    state.lastOkAt = Date.now()
    state.lastMs = ms
  }

  markFail(id, error) {
    const state = this.state(id)
    state.failures += 1
    const delay = Math.min(this.options.cooldownBaseMs * 2 ** (state.failures - 1), this.options.cooldownMaxMs)
    state.until = Date.now() + delay
    state.lastError = error instanceof Error ? error.message : String(error)
  }

  /** Snapshot for the free_search_test tool and diagnostics. */
  snapshot(keys) {
    const now = Date.now()
    return this.backends.map((backend) => {
      const state = this.health.get(backend.id)
      return {
        id: backend.id,
        label: backend.label,
        group: backend.group,
        timeFilter: backend.time,
        needsKey: backend.key ?? null,
        keyPresent: backend.key ? this.isUsable(backend, keys) : true,
        failures: state?.failures ?? 0,
        coolingMs: state && state.until > now ? state.until - now : 0,
        lastOkAt: state?.lastOkAt ?? null,
        lastMs: state?.lastMs ?? null,
        lastError: state?.lastError ?? null,
      }
    })
  }

  /** Build the attempt queue for one request. */
  order(request, keys) {
    const usable = this.backends.filter((backend) => this.isUsable(backend, keys))
    const start = this.cursor++
    const ring = rotate(usable, start)
    const healthy = ring.filter((backend) => !this.isCooling(backend.id))
    const cooling = ring.filter((backend) => this.isCooling(backend.id))

    let ordered
    if (request?.engine) {
      const explicit = usable.filter((backend) => backend.id === request.engine)
      ordered = [...explicit, ...healthy.filter((backend) => backend.id !== request.engine), ...cooling]
    } else if (request?.timeRange) {
      const timeCapable = healthy.filter((backend) => backend.time)
      const rest = [...healthy.filter((backend) => !backend.time), ...cooling]
      // Only advertise the window we can actually honor: if no time-capable
      // engine is usable, everything is still tried (best effort, noted).
      ordered = [...timeCapable, ...rest]
    } else {
      ordered = [...healthy, ...cooling]
    }

    const seen = new Set()
    const queue = []
    for (const backend of ordered) {
      if (seen.has(backend.id)) continue
      seen.add(backend.id)
      queue.push(backend)
      if (queue.length >= this.options.maxAttempts) break
    }
    return queue
  }

  /**
   * Run one search across the queue.
   * @returns {{ result, backend, attempts: Array<{backend,error,ms}> }}
   */
  async search(request, keys, options, signal) {
    const ctx = { keys, timeParsed: request.timeParsed, timeRange: request.timeRange, options }
    const queue = this.order(request, keys)
    if (queue.length === 0) {
      const error = new Error('no usable search backend: every engine is key-gated and no key is configured')
      error.code = 'MULQI_NO_BACKEND'
      throw error
    }
    const attempts = []
    for (const backend of queue) {
      if (signal?.aborted) {
        const error = new Error('search aborted')
        error.code = 'MULQI_ABORTED'
        throw error
      }
      const startedAt = Date.now()
      try {
        const raw = await withTimeout(
          Promise.resolve().then(() => backend.run(request.query, request.maxResults, ctx, signal)),
          backend.timeoutMs,
          backend.id,
        )
        const result = normalizeResult(raw)
        const ms = Date.now() - startedAt
        this.markOk(backend.id, ms)
        return { result, backend: backend.id, attempts: [...attempts, { backend: backend.id, ok: true, ms }] }
      } catch (error) {
        if (signal?.aborted) {
          const aborted = new Error('search aborted')
          aborted.code = 'MULQI_ABORTED'
          throw aborted
        }
        this.markFail(backend.id, error)
        attempts.push({
          backend: backend.id,
          ok: false,
          ms: Date.now() - startedAt,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        })
      }
    }
    const detail = attempts.map((attempt) => `${attempt.backend}: ${attempt.error}`).join(' | ')
    const error = new Error(`all ${attempts.length} search backends failed — ${detail}`)
    error.code = 'MULQI_ALL_BACKENDS_FAILED'
    error.attempts = attempts
    throw error
  }
}
