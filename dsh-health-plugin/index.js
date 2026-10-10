/**
 * dsh-health — Host half.
 *
 * Responsibilities, all registered inside `apply` so unload removes them:
 *   1. one `HealthService` instance behind every caller;
 *   2. the `health_*` / `sleep_*` agent tools;
 *   3. the `/api/health/*` routes the Web panel reads and writes;
 *   4. the short system-prompt section that tells the model where data lives.
 *
 * The window inside which the riskiest advice is given (CBT-I sleep
 * restriction) is decided in `src/sleep-analysis.js`, not here, so the tool
 * layer cannot accidentally bypass the contraindication screen.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { METRIC_KINDS } from './src/metrics.js'
import { HealthError, HealthService, withFlags } from './src/service.js'
import { loadDshPackage } from './src/resolve-dsh.js'
import { isHealthMode, modeText, setHealthMode, toggleHealthMode } from './src/health-mode.js'

/**
 * The plugin name, which the loader requires to equal the package name.
 *
 * Renamed from `dsh-health` because that name was already taken on npm by
 * another DSH plugin author. The route prefix below is deliberately left as
 * `/dsh-health`: it is a URL, nobody types the package name into the panel, and
 * churning it would break saved bookmarks for no gain.
 */
export const name = 'dsh-health-plugin'

/**
 * Services this plugin needs before it may activate.
 *
 * `systemPrompt` and `skills` are listed for a concrete reason: the context
 * refuses property access on an undefined injected service with
 * "cannot get property X without inject", so reaching for `ctx.systemPrompt`
 * while it is undeclared throws even when the service exists. Listing them
 * makes the dependency explicit and lets the plugin stay inactive in a
 * composition that genuinely lacks them.
 *
 * `web` is deliberately NOT listed. It is only needed for the one optional
 * feature of looking a drug up online, and putting an optional capability in
 * `inject` would take the entire plugin down — panel, tools and all — in any
 * composition that lacks a web provider. It is attached lazily instead; see
 * `apply`.
 */
export const inject = ['tools', 'webServer', 'systemPrompt', 'skills', 'commands']

/**
 * `defineTool` builds the validated definition `ctx.tools.register` accepts.
 *
 * It is resolved rather than imported: a profile-installed plugin lives outside
 * the Harness installation's module tree, so a bare `import
 * '@deepseek-ai/dsh-tools'` throws ERR_MODULE_NOT_FOUND and the plugin never
 * loads. See `src/resolve-dsh.js`. Failing here is loud on purpose — a missing
 * defineTool means every tool would silently disappear.
 */
const { defineTool } = await loadDshPackage('@deepseek-ai/dsh-tools')

if (typeof defineTool !== 'function') {
  throw new Error('dsh-health: @deepseek-ai/dsh-tools did not export defineTool')
}

const DEFAULTS = {
  dir: '',
  enabledKinds: [...METRIC_KINDS],
  verbose: false,
  systemPrompt: true,
  routes: true,
  skill: true
}

/**
 * Normalize the plugin row's `config`. Hand-rolled rather than schemastery so
 * the Host half depends on exactly one DSH package.
 *
 * @param {object} [config]
 */
export function resolveConfig(config) {
  const input = config ?? {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-health: config must be an object')
  }
  const unknown = Object.keys(input).filter((key) => !(key in DEFAULTS))
  if (unknown.length > 0) {
    throw new TypeError(`dsh-health: unknown config field(s): ${unknown.join(', ')}`)
  }
  const enabledKinds = input.enabledKinds === undefined
    ? DEFAULTS.enabledKinds
    : validateKinds(input.enabledKinds)
  return {
    dir: input.dir === undefined ? DEFAULTS.dir : String(input.dir),
    enabledKinds,
    verbose: input.verbose === undefined ? DEFAULTS.verbose : input.verbose === true,
    systemPrompt: input.systemPrompt === undefined ? DEFAULTS.systemPrompt : input.systemPrompt !== false,
    routes: input.routes === undefined ? DEFAULTS.routes : input.routes !== false,
    skill: input.skill === undefined ? DEFAULTS.skill : input.skill !== false
  }
}

function validateKinds(value) {
  const list = Array.isArray(value) ? value : [value]
  const kinds = list.map((kind) => String(kind).trim()).filter((kind) => kind.length > 0)
  if (kinds.length === 0) throw new TypeError('dsh-health: enabledKinds cannot be empty')
  const unknown = kinds.filter((kind) => !METRIC_KINDS.includes(kind))
  if (unknown.length > 0) {
    throw new TypeError(`dsh-health: unknown enabledKinds: ${unknown.join(', ')}; known: ${METRIC_KINDS.join(', ')}`)
  }
  return kinds
}

/**
 * Route namespace.
 *
 * Deliberately NOT under `/api`. The host's connection layer registers a
 * `prefix` route on `/api` for its own RPC channel, so an `/api/health/...`
 * request is claimed there first, and when the bridge finds no such RPC method
 * it answers with a plain-text `not found` — the panel's exact route is never
 * consulted, and the client sees "invalid JSON ... not found". A namespace of
 * our own is the whole fix.
 */
const ROUTE_PREFIX = '/dsh-health'

/**
 * The plugin's own activation log, inside the resolved data directory.
 *
 * Written only when `apply` actually runs, so its absence after a start is
 * positive evidence that the Host never mounted this row. That distinction is
 * otherwise invisible: the Host swallows activation diagnostics and a mounted
 * third-party row reports the same `status` as an unmounted one.
 */
let BOOT_LOG = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'health', 'plugin.log')

/** Resolve the configured directory, defaulting to the DSH home. */
function resolveDataDir(configured) {
  const raw = typeof configured === 'string' ? configured.trim() : ''
  if (raw.length > 0) {
    return resolve(raw.replace(/^~(?=[\\/]|$)/, homedir()))
  }
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(dshHome, 'health')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const dataDir = resolveDataDir(resolved.dir)
  const kinds = resolved.enabledKinds

  const log = (line) => {
    if (resolved.verbose) ctx.logger?.info?.(line)
  }

  const service = new HealthService({ dir: dataDir, log })
  // Exposed so a test harness can substitute stubs on the live instance.
  ctx.__service = service

  BOOT_LOG = join(dataDir, 'plugin.log')
  let maybeDisposer
  // Touch the archive immediately so the data directory exists from the first
  // start. Besides being friendlier ("open the folder" works before the first
  // record), it makes activation observable: a missing directory means the
  // plugin never applied, which is otherwise indistinguishable from a panel
  // bug when the Host swallows activation diagnostics.
  void service.store.ensureLayout()
    .then(() => writeBootLog(`${new Date().toISOString()} applied dir=${dataDir} kinds=${kinds.length}\n`))
    .catch((error) => writeBootLog(`${new Date().toISOString()} applied but ensureLayout failed: ${messageOf(error)}\n`))

  // Each registration below is journaled individually, and every registration
  // stays SYNCHRONOUS: a registration deferred past the end of `apply` can be
  // torn down with the context before it ever takes effect. Only the journal
  // write is immediate, because a plugin whose tools and routes vanish without
  // an error is otherwise undiagnosable from outside.
  const journal = (step, detail) => writeBootLog(`${new Date().toISOString()} ${step}${detail === undefined ? '' : ` ${detail}`}\n`)
  const attempt = (step, run) => {
    try {
      const detail = run()
      journal(step, `OK${detail === undefined ? '' : ` ${detail}`}`)
    } catch (error) {
      journal(step, `FAILED ${messageOf(error)}`)
    }
  }

  attempt('tools', () => {
    if (ctx.tools === undefined) throw new Error('ctx.tools is undefined')
    if (typeof ctx.tools.register !== 'function') throw new Error('ctx.tools.register is not a function')
    return `${registerTools(ctx, service, kinds)} registered`
  })

  attempt('web', () => {
    // Optional on purpose: `ctx.get` does not throw for an undeclared service
    // the way property access does, so a composition without a web provider
    // simply loses the online drug lookup instead of the whole plugin.
    const web = ctx.get?.('web')
    if (web === undefined) return 'unavailable (online drug lookup disabled)'
    service.web = web
    return 'attached'
  })

  attempt('prompt', () => {
    if (!resolved.systemPrompt) return 'disabled by config'
    if (typeof ctx.systemPrompt?.section !== 'function') throw new Error('ctx.systemPrompt.section is unavailable')
    addPromptSection(ctx, dataDir, kinds)
    return 'section added'
  })

  attempt('skill', () => {
    if (!resolved.skill) return 'disabled by config'
    const registered = registerSkill(ctx, log)
    return registered === undefined ? 'not registered (no skills service)' : registered
  })

  attempt('routes', () => {
    if (!resolved.routes) return 'disabled by config'
    if (ctx.webServer === undefined) throw new Error('ctx.webServer is undefined')
    if (typeof ctx.webServer.register !== 'function') throw new Error('ctx.webServer.register is not a function')
    return `${registerRoutes(ctx, service, log)} registered`
  })

  attempt('command', () => {
    if (ctx.commands === undefined) throw new Error('ctx.commands is undefined')
    if (typeof ctx.commands.register !== 'function') throw new Error('ctx.commands.register is not a function')
    registerHealthCommand(ctx)
    return '/health'
  })

  // Resolve the message builder in the background and journal the outcome: the
  // /health command can only hand a sentence to the model if this resolves.
  void primeUserMessageFactory().then(
    (ok) => journal('inject-helper', ok ? 'ready' : 'UNAVAILABLE'),
    (error) => journal('inject-helper', `FAILED ${messageOf(error)}`)
  )

  attempt('effect', () => {
    if (typeof ctx.effect !== 'function') throw new Error('ctx.effect is not a function')
    maybeDisposer = ctx.effect(() => () => journal('effect', 'disposed'))
    return maybeDisposer === undefined ? 'returned undefined (disposer unavailable)' : 'disposer captured'
  })

  journal('apply', 'returned')

  return () => {
    journal('dispose', 'called')
    log('dsh-health: disposed')
  }
}

// ----------------------------------------------------------------- command ---

/**
 * The `/health` command: a free on/off switch for health mode.
 *
 * A command runs without a model turn, so this flips a process-local flag that
 * the prompt variable reads on the next assembly. `/health on`, `/health off`
 * and a bare `/health` that toggles are all accepted, because the bare form is
 * what a user types when they just want the switch.
 */
function registerHealthCommand(ctx) {
  ctx.commands.register({
    name: 'health',
    description: '开关健康模式；也可写成 /health <要说的话>，开启模式并把这句话交给助手。',
    input: { hint: '[on|off|status] 或直接跟一句话' },
    async handler(invocation) {
      const agent = invocation?.agent
      const argument = String(invocation?.rawInput ?? '').trim()

      // Record the invocation surface once, so "can a command hand text to the
      // model?" is answered by evidence from a real run rather than by reading
      // bundled types.
      probeCommandSurface(agent, argument)

      const parsed = parseHealthInput(argument)

      if (parsed.action === 'status') {
        return { kind: 'success', text: describeMode(isHealthMode(agent)) }
      }

      const enabled = parsed.action === 'toggle'
        ? toggleHealthMode(agent)
        : setHealthMode(agent, parsed.action === 'on')

      // A message typed after /health must not be swallowed by the command: the
      // user wrote a sentence, and it should reach the assistant.
      if (parsed.message !== undefined) {
        const delivered = await deliverMessage(agent, parsed.message)
        return { kind: 'success', text: `${describeMode(enabled)}\n\n${delivered}` }
      }
      return { kind: 'success', text: describeMode(enabled) }
    }
  })
}

/**
 * Build a user message the way the Host does, or undefined when the helper is
 * unavailable.
 *
 * `agent.inject` takes a message object, not a string: the bundled callers all
 * pass `createUserMessage({ content, source })`, which stamps a role and a fresh
 * id and freezes the result. Reconstructing that by hand would eventually drift
 * from the real shape, so the helper is resolved from the installation.
 *
 * Resolution is lazy and non-fatal: a failure here degrades the command to
 * "please resend that as a normal message" instead of costing the whole plugin.
 *
 * @returns {Promise<((text: string) => object) | undefined>}
 */
let userMessageFactory
async function loadUserMessageFactory() {
  if (userMessageFactory !== undefined) return userMessageFactory
  try {
    const llm = await loadDshPackage('@deepseek-ai/dsh-llm')
    const create = llm?.createUserMessage
    if (typeof create !== 'function') {
      userMessageFactory = null
      return undefined
    }
    userMessageFactory = (text) => create({
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-health' }
    })
    return userMessageFactory
  } catch (error) {
    writeBootLog(`${new Date().toISOString()} inject-helper unavailable: ${messageOf(error)}\n`)
    userMessageFactory = null
    return undefined
  }
}

/**
 * Test seam: supply a message factory instead of resolving one.
 * `null` forces the "helper unavailable" path.
 *
 * @param {((text: string) => object) | null | undefined} factory
 */
export function setUserMessageFactoryForTest(factory) {
  userMessageFactory = factory
}

/**
 * Resolve the message builder now, so a broken resolution is visible in the
 * boot journal instead of appearing later as a command that silently cannot
 * deliver anything.
 */
export async function primeUserMessageFactory() {
  return (await loadUserMessageFactory()) !== undefined
}

/**
 * Split `/health` input into an action and an optional message.
 *
 * The rule that matters: only a *recognized* single word is a subcommand.
 * Anything else is the user's own sentence, because `/health 我昨天睡得很差…`
 * is a person talking to their assistant, not a malformed option. Treating it
 * as an error was the first version's mistake, and it cost the user their
 * message: a command line is consumed whole, so the sentence never reached the
 * model.
 */
export function parseHealthInput(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text.length === 0) return { action: 'toggle' }

  // `on` / `off` followed by anything is the most natural way to say "turn this
  // on and here is my message". It has to be matched before the generic word
  // split, because in that form the remainder is a sentence rather than the
  // rest of a subcommand.
  const forced = /^(on|off)\s+([\s\S]+)$/i.exec(text)
  if (forced !== null) {
    return { action: forced[1].toLowerCase(), message: forced[2].trim() }
  }

  const match = /^([A-Za-z]+)\b([\s\S]*)$/.exec(text)
  const word = match === null ? null : match[1].toLowerCase()
  const rest = match === null ? text : match[2].trim()

  if (word === 'on' || word === 'off') return { action: word }
  if (word === 'status') {
    return rest.length === 0 ? { action: 'status' } : { action: 'status', message: rest }
  }

  // Not a subcommand: the user's own words. Turn the mode on, because asking the
  // health assistant something is exactly what /health is for.
  return { action: 'on', message: text }
}

/**
 * Hand a message to the agent, if the command surface allows it.
 *
 * Always returns the line to show in the transcript, so the user learns what
 * happened to their sentence instead of watching it disappear.
 */
async function deliverMessage(agent, message) {
  if (typeof agent?.inject !== 'function') {
    return '⚠️ 这句话没有被交给助手（当前版本不支持从命令注入消息）。请把它作为普通消息再发一次。'
  }
  const build = await loadUserMessageFactory()
  if (build === undefined) {
    return '⚠️ 这句话没有被交给助手（消息构造器不可用）。请把它作为普通消息再发一次。'
  }
  try {
    agent.inject(build(message))
    return '已把这句话交给助手处理。'
  } catch (error) {
    return `⚠️ 注入消息失败：${messageOf(error)}。请把这句话作为普通消息再发一次。`
  }
}

/** Write one line about the command invocation surface, at most once per start. */
let commandProbeWritten = false
function probeCommandSurface(agent, argument) {
  if (commandProbeWritten) return
  commandProbeWritten = true
  let keys = []
  try {
    const own = agent !== null && typeof agent === 'object' ? Object.keys(agent) : []
    const proto = agent === null || agent === undefined ? {} : Object.getOwnPropertyNames(Object.getPrototypeOf(agent) ?? {})
    keys = [...new Set([...own, ...proto])].slice(0, 40)
  } catch {
    keys = ['(unreadable)']
  }
  writeBootLog(
    `${new Date().toISOString()} command-probe agentType=${typeof agent} `
    + `inject=${typeof agent?.inject} session=${typeof agent?.session} `
    + `argLength=${argument.length} keys=${keys.join(',')}\n`
  )
}

/** One-line status text returned to the transcript. */
function describeMode(enabled) {
  return enabled
    ? '健康模式：已开启。接下来按私人健康顾问的方式工作——先查档案再给建议，睡眠优先，用药查成文说明，缺数据直说。'
    : '健康模式：已关闭。仍然可以记录与查询数据，但不会再主动展开健康建议。'
}

// ------------------------------------------------------------- prompt text ---

/**
 * The prompt section that tells the model where the archive lives.
 */
function addPromptSection(ctx, dataDir, kinds) {
  const body = [
    `你的健康档案在本机：${dataDir}（明文 JSON/JSONL，用户可自行查看与删除）。`,
    `可记录类型：${kinds.join('、')}。`,
    '{{health_mode}}',
    '写档案一律通过 health_record / health_bulk_record / sleep_log / medication_taken 工具，'
    + '不要用文件工具直接改这些文件，否则会绕过取值范围校验、临床红线标记与睡眠派生指标的计算。',
    '睡眠数据必须经 sleep_log 或 health_record(kind="sleep") 写入，'
    + '这样"睡眠效率"等 CBT-I 决策依赖的数字才由代码算出，而不是靠推算。',
    // The single most damaging thing this plugin could do is put a fabricated
    // number where the user's own measurement belongs: the panel cannot tell
    // them apart later, and the whole record becomes untrustworthy.
    '**只记录用户自己报告或实测的数字。**绝对不要为了演示、测试、示例或"让界面好看"而调用这些工具，'
    + '也不要根据印象、对话上下文或统计常识推测一个数值写进去。'
    + '没被告知的数值就不存在——缺失是允许的状态，编造不是。'
    + '如果确实需要写入示例数据（例如用户明确要求），必须传 source="sample"，它会在面板上被标记为示例。',
    // Medication is the place where improvising is most dangerous.
    '涉及具体药物时，忌口、相互作用、监测项目**必须**通过 drug_notes 工具取说明，'
    + '不要凭记忆回答，包括你自认为熟悉的药。'
    + '该工具先查本插件的成文条目；没有条目时它会**自动联网检索**并返回带来源链接的原文摘录。'
    + '拿到 `web` 摘录时，请**引用原文并给出链接**，不要把它说成插件的成文说明，也不要从中摘录之外补充你自己的记忆。'
    + '检索失败或没命中权威来源时，如实说明并让用户查说明书或问药师。',
    '剂量、疗程与分次完全以处方为准：不要建议加量、减量或停药，也不要替医生决定"一天几颗"。'
  ].join('\n')

  // A prompt variable is evaluated per assembly, so the mode line reflects the
  // live session without touching the section text — which keeps the prompt
  // prefix stable and cacheable either way.
  ctx.systemPrompt.variable('health_mode', (context) => modeText(isHealthMode(context?.agent)))

  ctx.systemPrompt.section({
    name: 'health:record',
    order: 50,
    text: body
  })
}

/** Append one line to the plugin's own boot log inside the data directory. */
function writeBootLog(line) {
  try {
    writeFileSync(BOOT_LOG, line, { encoding: 'utf8', flag: 'a' })
  } catch {
    // Diagnostics must never be the reason a health write fails.
  }
}

// ------------------------------------------------------------------ tools ---

function registerTools(ctx, service, kinds) {
  /**
   * Register one tool and record its name.
   *
   * The name list is kept as a side effect of registration rather than as a
   * hand-maintained array: a hardcoded list drifts the moment a tool is added,
   * and the journal would then report a count the registry never had.
   */
  const register = (definition) => {
    ctx.tools.register(defineTool(definition))
    TOOL_NAMES.push(definition.name)
  }

  register({
    name: 'health_record',
    description: 'Record one health measurement into the user\'s local health archive. '
      + `Supported kinds: ${kinds.join(', ')}. `
      + 'For sleep always pass bedtime plus out_of_bed/final_wake; the tool computes time in bed, '
      + 'total sleep time and sleep efficiency, which later CBT-I advice depends on. '
      + 'Values are range-checked and clinically dangerous readings are flagged back to you. '
      + 'Write ONLY values the user actually reported or measured. Never write a plausible-looking '
      + 'number to make the archive or the panel look complete, and never infer one from context.',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        description: `Record kind. One of: ${kinds.join(', ')}.`,
        enum: kinds
      },
      value: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description: 'Values for this kind. '
          + 'sleep: {bedtime, out_of_bed, final_wake, sleep_onset_min, waso_min, awake_final_min, quality, caffeine, alcohol, screens_off, naps}; '
          + 'weight: {kg}; blood_pressure: {systolic, diastolic, pulse}; heart_rate: {bpm}; temperature: {celsius}; '
          + 'glucose: {mmol, context}; exercise: {activity, minutes, intensity}; steps: {count}; '
          + 'diet: {meal, description}; mood: {mood, score}; symptom: {name, severity}; '
          + 'medication: {name, dose}; menstrual: {phase, flow}; lab: {item, measure, unit}.'
      },
      date: { type: 'string', description: 'Local date YYYY-MM-DD. Defaults to today.' },
      note: { type: 'string', description: 'Free-text note, e.g. context or how the user felt.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      source: {
        type: 'string',
        description: 'Provenance. Leave unset for the user\'s own report. '
          + 'Use "sample" only when the user explicitly asks for demo data: the panel badges those records as 示例数据. '
          + 'Use "device" or "import" for values from an external device or file.',
        enum: ['user', 'agent', 'import', 'device', 'sample']
      }
    },
    output: HEALTH_OUTPUT,
    async execute(args) {
      const flat = { ...(args.value ?? {}), date: args.date, note: args.note, tags: args.tags, source: args.source }
      return service.record(args.kind, flat)
    }
  })

  register({
    name: 'health_bulk_record',
    description: 'Record several health measurements in one call. '
      + 'Use this when the user reports a whole day at once (sleep plus weight plus symptoms) '
      + 'instead of issuing one health_record call per item. '
      + 'Every entry is validated independently: the reply lists what was stored and what was rejected.',
    parameters: {
      entries: {
        type: 'array',
        required: true,
        description: 'Entries to store, in order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, description: `One of: ${kinds.join(', ')}.` },
            value: { type: 'object', additionalProperties: true, required: true, description: 'Values for this kind.' },
            date: { type: 'string', description: 'Local date YYYY-MM-DD.' },
            note: { type: 'string', description: 'Optional note.' },
            source: {
              type: 'string',
              description: 'Provenance; "sample" for user-requested demo data.',
              enum: ['user', 'agent', 'import', 'device', 'sample']
            }
          }
        }
      }
    },
    output: HEALTH_OUTPUT,
    async execute(args) {
      const stored = []
      const failed = []
      for (const entry of args.entries ?? []) {
        try {
          stored.push(await service.record(entry.kind, {
            ...(entry.value ?? {}),
            date: entry.date,
            note: entry.note,
            source: entry.source
          }))
        } catch (error) {
          failed.push({ kind: entry.kind, date: entry.date ?? null, error: messageOf(error) })
        }
      }
      return { ok: failed.length === 0, stored, failed, count: stored.length }
    }
  })

  register({
    name: 'health_query',
    description: 'Read records back out of the local health archive. '
      + 'Use it before giving advice that depends on history (trends, comparisons, "has this happened before"). '
      + 'Records come back newest first, each with a `summary` line and any clinical `flags`.',
    parameters: {
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: `Restrict to these kinds: ${kinds.join(', ')}.`
      },
      from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
      to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Defaults to today.' },
      days: { type: 'number', description: 'Convenience: the trailing N days ending at `to`.' },
      limit: { type: 'number', description: 'Maximum records to return. Defaults to 200.' }
    },
    output: HEALTH_OUTPUT,
    execute(args) {
      return service.query(args)
    }
  })

  register({
    name: 'health_overview',
    description: 'One call that answers "where do I stand": the latest value of every metric, '
      + 'the record kinds that have data, and any dangerous readings in the recent window. '
      + 'Prefer this over several health_query calls when you need orientation.',
    parameters: {
      days: { type: 'number', description: 'Window for the recent-flag scan. Defaults to 30.' }
    },
    output: HEALTH_OUTPUT,
    async execute(args) {
      const days = Number.isFinite(Number(args.days)) ? Math.max(1, Math.floor(Number(args.days))) : 30
      const dashboard = await service.dashboard({ days })
      const latest = await service.latest()
      return {
        ok: true,
        today: dashboard.today,
        window: dashboard.window,
        lastNight: dashboard.lastNight,
        latest: latest.latest,
        todayRecords: dashboard.todayRecords,
        flagged: dashboard.summary.flagged,
        sleep: {
          nightsRecorded: dashboard.sleep.analysis.nights,
          mean: dashboard.sleep.analysis.mean,
          debt: dashboard.sleep.analysis.debt,
          insomniaScreen: dashboard.sleep.analysis.insomniaScreen,
          warnings: dashboard.sleep.analysis.warnings
        },
        hasProfile: dashboard.profile !== null
      }
    }
  })

  register({
    name: 'sleep_log',
    description: 'Log one night of sleep. This is the highest-value record in the archive: '
      + 'bedtime plus rise time is enough, and every insomnia recommendation depends on these numbers. '
      + 'sleep_onset_min (how long it took to fall asleep) and waso_min (minutes awake during the night) '
      + 'sharpen the picture substantially — ask for them if the user did not say. '
      + 'Log only a night the user actually described. Never invent times to fill the diary, and never '
      + 'reconstruct a night from a general impression: an empty diary is an honest state, a fabricated '
      + 'one silently corrupts every CBT-I number computed from it.',
    parameters: {
      date: { type: 'string', description: 'The date the user woke up on. Defaults to today.' },
      bedtime: { type: 'string', required: true, description: 'Clock time of getting into bed, e.g. "23:40".' },
      out_of_bed: { type: 'string', description: 'Clock time of getting out of bed, e.g. "07:10". Preferred over final_wake.' },
      final_wake: { type: 'string', description: 'Clock time of the final awakening, if different from getting up.' },
      sleep_onset_min: { type: 'number', description: 'Minutes to fall asleep (sleep latency).' },
      waso_min: { type: 'number', description: 'Total minutes awake after falling asleep.' },
      quality: { type: 'number', description: 'Subjective quality, 1-5.' },
      caffeine: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Caffeine intake, e.g. [{at:"18:00", mg:120}].' },
      alcohol: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Alcohol intake, e.g. [{at:"21:00", units:2}].' },
      screens_off: { type: 'string', description: 'Clock time of the last screen use.' },
      naps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Naps, e.g. [{at:"14:00", minutes:20}].' },
      note: { type: 'string', description: 'Anything else worth remembering about the night.' },
      source: {
        type: 'string',
        description: 'Provenance; leave unset for a night the user described, "sample" for demo data.',
        enum: ['user', 'agent', 'device', 'sample']
      }
    },
    output: HEALTH_OUTPUT,
    execute(args) {
      return service.record('sleep', args)
    }
  })

  register({
    name: 'sleep_analyze',
    description: 'Analyze the sleep diary and produce the CBT-I plan. '
      + 'Returns mean total sleep time, time in bed, sleep efficiency, latency, WASO, cumulative sleep debt, '
      + 'circadian phase spread, behavior correlations, an insomnia-pattern screen, and a concrete plan: '
      + 'a fixed rising time plus the bedtime that produces the prescribed time in bed. '
      + 'It also returns `safety.refusals` — when those are present the behavioural plan is withheld on purpose '
      + '(red flags, contraindications, or too few diary nights). '
      + 'Relay refusals and red flags instead of improvising your own version of the plan.',
    parameters: {
      days: { type: 'number', description: 'Diary window in days. Defaults to 14; 7-14 is the useful range.' },
      to: { type: 'string', description: 'End date YYYY-MM-DD. Defaults to today.' }
    },
    output: HEALTH_OUTPUT,
    execute(args) {
      return service.sleepAnalysis(args)
    }
  })

  register({
    name: 'health_report',
    description: 'Generate a periodic health report as Markdown, including the per-metric comparison '
      + 'against the previous window of the same length. Good for "how was my week", for a pre-appointment '
      + 'summary, and for spotting a trend the user has not noticed.',
    parameters: {
      days: { type: 'number', description: 'Window length in days. Defaults to 7; use 30 for a month.' },
      to: { type: 'string', description: 'End date YYYY-MM-DD. Defaults to today.' }
    },
    output: HEALTH_OUTPUT,
    execute(args) {
      return service.report(args)
    }
  })

  register({
    name: 'health_profile',
    description: 'Read or update the standing health profile: birth year, height, conditions, medications, '
      + 'allergies, goals, habits, and the target rising time the sleep plan anchors to. '
      + 'Sleep restriction is contraindicated in some conditions, so conditions/medications here change what '
      + 'sleep_analyze will agree to prescribe — keep them accurate rather than optimistic.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'read, or update.',
        enum: ['read', 'update']
      },
      patch: {
        type: 'object',
        additionalProperties: true,
        description: 'For action=update: fields to merge. e.g. {birthYear:1998, heightCm:175, '
          + 'conditions:["高血压"], medications:["氨氯地平"], targetWake:"06:40", safetyCritical:false}. '
          + 'Unknown fields are preserved; credential-looking keys are refused.'
      }
    },
    output: HEALTH_OUTPUT,
    async execute(args) {
      if (args.action === 'read') return service.readProfile()
      if (args.action === 'update') return service.updateProfile(args.patch ?? {})
      throw new HealthError(`unknown action ${JSON.stringify(args.action)}; expected read or update`, 'HEALTH_INVALID_ACTION')
    }
  })

  register({
    name: 'health_manage',
    description: 'Correct or delete a record that is already stored. '
      + 'Get the record `id` from health_query or health_overview first. '
      + 'Use action=update to fix a mistyped value (the corrected record is re-validated) '
      + 'and action=delete to remove an entry that should not be there.',
    parameters: {
      action: { type: 'string', required: true, description: 'update or delete.', enum: ['update', 'delete'] },
      id: { type: 'string', required: true, description: 'Record id from a previous query.' },
      value: { type: 'object', additionalProperties: true, description: 'For update: the value fields to change.' },
      date: { type: 'string', description: 'For update: a corrected date YYYY-MM-DD.' },
      note: { type: 'string', description: 'For update: a corrected note.' }
    },
    output: HEALTH_OUTPUT,
    async execute(args) {
      if (args.action === 'delete') return service.remove(args.id)
      if (args.action === 'update') {
        return service.update(args.id, { value: args.value, date: args.date, note: args.note })
      }
      throw new HealthError(`unknown action ${JSON.stringify(args.action)}; expected update or delete`, 'HEALTH_INVALID_ACTION')
    }
  })

  register({
    name: 'medication_regimen',
    description: 'Register, read, or remove a STANDING medication — the prescription itself: what, how much, '
      + 'how often, at which clock times, whether it needs food. Use this when the user tells you what they '
      + 'were prescribed, so reminders can be scheduled and the drug\'s written notes can be attached. '
      + 'Record exactly what the prescriber said: this tool never chooses a dose or a frequency, and it '
      + 'refuses a "twice daily" regimen that has no times, because without times no reminder can fire. '
      + 'After registering, offer to create the reminders with schedule_create using the daily rule and the '
      + 'timezone that time-context reports.',
    parameters: {
      action: { type: 'string', required: true, description: 'save, list, or remove.', enum: ['save', 'list', 'remove'] },
      name: { type: 'string', description: 'save: the drug name as prescribed, e.g. "异维A酸".' },
      dose: { type: 'string', description: 'save: the prescribed strength per intake, e.g. "10mg" or "20mg".' },
      units_per_dose: { type: 'number', description: 'save: how many tablets/capsules per intake, e.g. 2.' },
      formulation: {
        type: 'string',
        description: 'save: dosage form, which decides whether it may be split. See the drug notes.',
        enum: ['tablet', 'capsule', 'softgel', 'sustained_release', 'enteric', 'solution']
      },
      frequency: {
        type: 'string',
        description: 'save: prescribed frequency.',
        enum: ['once_daily', 'twice_daily', 'three_times_daily', 'every_other_day', 'weekly', 'as_needed', 'custom']
      },
      times: {
        type: 'array',
        items: { type: 'string' },
        description: 'save: clock times in HH:MM, one per daily intake, e.g. ["08:00","20:00"]. '
          + 'Required for the daily frequencies.'
      },
      with_food: {
        type: 'string',
        description: 'save: whether food is required.',
        enum: ['must', 'either', 'empty_stomach']
      },
      start_date: { type: 'string', description: 'save: YYYY-MM-DD, defaults to today.' },
      end_date: { type: 'string', description: 'save: YYYY-MM-DD when the course ends, if known.' },
      prescriber: { type: 'string', description: 'save: who prescribed it, if the user said.' },
      reason: { type: 'string', description: 'save: what it is being treated, if the user said.' },
      notes: { type: 'string', description: 'save: the user\'s own instructions, e.g. "与早餐同服".' },
      remind: { type: 'boolean', description: 'save: whether reminders are wanted. Defaults to true.' },
      id: { type: 'string', description: 'remove: the regimen id returned by list.' }
    },
    output: HEALTH_OUTPUT,
    async execute(args) {
      if (args.action === 'list') return service.listMedications()
      if (args.action === 'remove') return service.removeMedication(args.id)
      if (args.action === 'save') {
        return service.saveMedication({
          name: args.name,
          dose: args.dose,
          unitsPerDose: args.units_per_dose,
          formulation: args.formulation,
          frequency: args.frequency,
          times: args.times,
          withFood: args.with_food,
          startDate: args.start_date,
          endDate: args.end_date,
          prescriber: args.prescriber,
          reason: args.reason,
          notes: args.notes,
          remind: args.remind
        })
      }
      throw new HealthError(`unknown action ${JSON.stringify(args.action)}; expected save, list, or remove`, 'HEALTH_INVALID_ACTION')
    }
  })

  register({
    name: 'drug_notes',
    description: 'Written notes for a drug: dietary and interaction restrictions, the side effects to expect, '
      + 'routine monitoring, supportive care, the essentials to repeat in a reminder, and the red flags that '
      + 'mean call someone. '
      + 'Answers come from two places, in this order: this plugin\'s curated notes when it has them, and '
      + 'otherwise a web lookup that returns **quoted passages with their source links**. '
      + 'Always use this tool instead of recalling drug facts yourself, including for drugs you think you know. '
      + 'When the reply carries `web` results, quote them and cite the URLs; never present a web passage as if '
      + 'it were a curated note, and never fill gaps from memory. '
      + 'It never states a dose: dosage belongs to the prescriber and the label.',
    parameters: {
      name: { type: 'string', required: true, description: 'Drug name as the user wrote or said it, in Chinese or English.' },
      focus: {
        type: 'string',
        description: 'Optional: concentrate the lookup on one facet.',
        enum: ['restrictions', 'monitoring', 'sideEffects', 'supportive', 'redFlags', 'dosing', 'timing']
      },
      source: {
        type: 'string',
        description: 'auto (default) reads the curated notes and falls back to the web; notes forces curated '
          + 'notes only; web forces a web lookup.',
        enum: ['auto', 'notes', 'web']
      }
    },
    output: HEALTH_OUTPUT,
    execute(args, exec) {
      return service.drugNotes(args.name, {
        focus: args.focus,
        source: args.source,
        signal: exec?.signal
      })
    }
  })

  register({
    name: 'medication_taken',
    description: 'Log that one dose was actually taken. This is what makes adherence answerable later '
      + '("did I miss any this week"), so log it when the user says they took it — not when a reminder fires. '
      + 'Include the side effects the user reports so they can be trended rather than forgotten.',
    parameters: {
      name: { type: 'string', required: true, description: 'Drug name.' },
      dose: { type: 'string', description: 'The dose taken, if different from the regimen.' },
      date: { type: 'string', description: 'Local date YYYY-MM-DD. Defaults to today.' },
      at: { type: 'string', description: 'Clock time HH:MM, if the user gave one.' },
      skipped: { type: 'boolean', description: 'Set true to record a deliberately skipped dose.' },
      side_effects: { type: 'string', description: 'Any side effect noticed after this dose.' },
      note: { type: 'string', description: 'Anything else worth remembering.' }
    },
    output: HEALTH_OUTPUT,
    execute(args) {
      const noteParts = []
      if (args.side_effects) noteParts.push(`不良反应：${args.side_effects}`)
      if (args.note) noteParts.push(args.note)
      return service.record('medication', {
        name: args.name,
        dose: args.dose,
        adherence: args.skipped === true ? 'skipped' : 'taken',
        side_effects: args.side_effects,
        date: args.date,
        clock: args.at,
        note: noteParts.length > 0 ? noteParts.join('；') : undefined,
        source: 'user'
      })
    }
  })

  return TOOL_NAMES.length
}

/**
 * The tool names this plugin registered, in registration order.
 *
 * Filled by `registerTools`, not maintained by hand: the journal reports this
 * length, so a hardcoded list would eventually claim a count the registry never
 * had.
 */
export const TOOL_NAMES = []

// ------------------------------------------------------------------- skill ---

/** Where the bundled CBT-I protocol lives, relative to this module. */
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'skills', 'health-insomnia-protocol')
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

/**
 * Register the bundled insomnia protocol as a runtime skill.
 *
 * `skills` is deliberately not in `inject`: a composition without a skill
 * registry must still record health data. The registration is read from disk at
 * apply time, and a missing or malformed file degrades to a warning rather than
 * taking the whole plugin down — losing the skill costs coaching quality, not
 * the user's records.
 */
function registerSkill(ctx, log) {
  // Declared in `inject`, so this is a plain property access.
  const skills = ctx.skills
  if (typeof skills?.register !== 'function') {
    log('dsh-health: no skills service; the insomnia protocol skill was not registered')
    return undefined
  }

  let parsed
  try {
    parsed = parseSkillDocument(readFileSync(SKILL_FILE, 'utf8'))
  } catch (error) {
    return `FAILED to read the bundled skill: ${messageOf(error)}`
  }

  try {
    skills.register({
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: SKILL_DIR }
    })
    log(`dsh-health: registered skill ${parsed.name}`)
    return parsed.name
  } catch (error) {
    // A duplicate name is the expected failure: it means another copy is loaded.
    return `FAILED to register ${parsed.name}: ${messageOf(error)}`
  }
}

/**
 * Split a SKILL.md into its frontmatter fields and body.
 *
 * Only the flat `key: value` subset is supported, which is what every skill in
 * the Harness uses; anything more would need a YAML dependency this plugin
 * deliberately avoids.
 *
 * @param {string} text
 * @returns {{ name: string, description: string, content: string, meta: Record<string, string> }}
 */
export function parseSkillDocument(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('skill document is empty')
  }
  let meta = {}
  let body = text
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match !== null) {
    meta = parseFlatYaml(match[1])
    body = text.slice(match[0].length)
  }
  const name = meta.name
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('skill document is missing a frontmatter `name`')
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name.trim())) {
    throw new TypeError(`skill name must be kebab-case, got ${JSON.stringify(name)}`)
  }
  const description = meta.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new TypeError(`skill ${name} is missing a frontmatter \`description\``)
  }
  if (body.trim().length === 0) {
    throw new TypeError(`skill ${name} has an empty body`)
  }
  return { name: name.trim(), description: description.trim(), content: body.trim(), meta }
}

/** Flat `key: value` pairs, plus `>-` / `|` folded and literal blocks. */
function parseFlatYaml(text) {
  const out = {}
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const match = /^([A-Za-z0-9_-]+):\s?(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    let value = match[2]
    if (value === '>-' || value === '>' || value === '|' || value === '|-') {
      const folded = value.startsWith('>')
      const collected = []
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        collected.push(lines[index + 1].trim())
        index++
      }
      value = folded ? collected.join(' ') : collected.join('\n')
    } else {
      value = value.trim().replace(/^["']|["']$/g, '')
    }
    out[key] = value
  }
  return out
}

// ----------------------------------------------------------------- routes ---

const MAX_BODY_BYTES = 1024 * 1024

function registerRoutes(ctx, service, log) {
  /**
   * Register one route.
   *
   * The web server keys routes by path, so a path may be registered exactly
   * once: verbs that share a path (`GET` and `POST /profile`) must be listed
   * together and dispatched here. Registering the same path twice silently
   * keeps only one of them, which is how the panel's profile update once ended
   * up unreachable.
   *
   * @param {string | readonly string[]} methods
   * @param {string} path
   * @param {Record<string, (input: object) => unknown> | ((input: object) => unknown)} handler
   */
  const handle = (methods, path, handler) => {
    const allowed = Array.isArray(methods) ? methods : [methods]
    return ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (request, response) => {
        void dispatch({ methods: allowed, handler, request, response, log })
      }
    }, `dsh-health: ${allowed.join('|')} ${path}`))
  }

  handle('GET', `${ROUTE_PREFIX}/status`, () => service.status())
  handle('GET', `${ROUTE_PREFIX}/catalog`, () => service.catalog())
  handle('GET', `${ROUTE_PREFIX}/dashboard`, ({ query }) => service.dashboard({
    days: query.get('days') ?? undefined,
    to: query.get('to') ?? undefined
  }))
  handle('GET', `${ROUTE_PREFIX}/records`, ({ query }) => service.query({
    kinds: query.getAll('kind').length > 0 ? query.getAll('kind') : (query.get('kinds') ?? undefined),
    from: query.get('from') ?? undefined,
    to: query.get('to') ?? undefined,
    days: query.get('days') ?? undefined,
    limit: query.get('limit') ?? undefined
  }))
  handle('GET', `${ROUTE_PREFIX}/trends`, ({ query }) => service.trends({
    days: query.get('days') ?? undefined,
    to: query.get('to') ?? undefined,
    kinds: query.get('kinds') ?? undefined
  }))
  handle('GET', `${ROUTE_PREFIX}/sleep`, ({ query }) => service.sleepAnalysis({
    days: query.get('days') ?? undefined,
    to: query.get('to') ?? undefined
  }))
  handle('GET', `${ROUTE_PREFIX}/report`, ({ query }) => service.report({
    days: query.get('days') ?? undefined,
    to: query.get('to') ?? undefined
  }))
  handle('GET', `${ROUTE_PREFIX}/latest`, () => service.latest())
  handle('GET', `${ROUTE_PREFIX}/export`, () => service.exportAll())

  // One path, two verbs: read with GET, merge a patch with POST.
  handle(['GET', 'POST'], `${ROUTE_PREFIX}/profile`, ({ body, method }) => {
    if (method === 'GET') return service.readProfile()
    return service.updateProfile(body ?? {})
  })

  handle('POST', `${ROUTE_PREFIX}/record`, ({ body }) => {
    if (body === null || typeof body !== 'object') throw new HealthError('body must be a JSON object', 'HEALTH_INVALID_BODY')
    const { kind, value, ...rest } = body
    if (typeof kind !== 'string') throw new HealthError('body.kind is required', 'HEALTH_INVALID_BODY')
    // Accept the tool-shaped `value` envelope as well as flat fields, so the
    // panel form and a raw curl body both work.
    return service.record(kind, flattenValue(value, rest))
  })
  handle('POST', `${ROUTE_PREFIX}/update`, ({ body }) => {
    if (typeof body?.id !== 'string') throw new HealthError('body.id is required', 'HEALTH_INVALID_BODY')
    const { id, ...patch } = body
    return service.update(id, patch)
  })
  handle('POST', `${ROUTE_PREFIX}/delete`, ({ body }) => {
    if (typeof body?.id !== 'string') throw new HealthError('body.id is required', 'HEALTH_INVALID_BODY')
    return service.remove(body.id)
  })
  handle('POST', `${ROUTE_PREFIX}/sleep-log`, ({ body }) => service.record('sleep', body ?? {}))
  handle('POST', `${ROUTE_PREFIX}/clear-samples`, () => service.removeSampleRecords())

  handle('GET', `${ROUTE_PREFIX}/medications`, () => service.listMedications())
  handle('POST', `${ROUTE_PREFIX}/medication`, ({ body }) => service.saveMedication(body ?? {}))
  handle('POST', `${ROUTE_PREFIX}/medication/delete`, ({ body }) => {
    if (typeof body?.id !== 'string') throw new HealthError('body.id is required', 'HEALTH_INVALID_BODY')
    return service.removeMedication(body.id)
  })
  handle('GET', `${ROUTE_PREFIX}/drug`, ({ query }) => service.drugNotes(query.get('name') ?? '', {
    focus: query.get('focus') ?? undefined,
    source: query.get('source') ?? undefined
  }))
  handle('GET', `${ROUTE_PREFIX}/drug-catalog`, () => service.drugCatalog())
  handle('POST', `${ROUTE_PREFIX}/open-folder`, async () => {
    const { root } = service.store.paths()
    await openPath(root, service)
    return { ok: true, opened: root }
  })

  return ROUTE_PATHS.length
}

/** Every route path this plugin serves, for the journal and for tests. */
export const ROUTE_PATHS = [
  'status', 'catalog', 'dashboard', 'records', 'trends', 'sleep', 'report',
  'latest', 'export', 'profile', 'record', 'update', 'delete', 'sleep-log',
  'open-folder', 'clear-samples',
  'medications', 'medication', 'medication/delete', 'drug', 'drug-catalog'
].map((name) => `${ROUTE_PREFIX}/${name}`)

/**
 * One place that turns a handler result into an HTTP response, so every route
 * shares the same error contract: `{ ok: false, error, code }` with a 4xx/5xx.
 *
 * `handler` is either one function for every allowed verb, or a map of verb to
 * function.
 */
async function dispatch({ methods, handler, request, response, log }) {
  try {
    const method = String(request.method ?? 'GET').toUpperCase()
    if (!methods.includes(method)) {
      response.writeHead(405, { allow: methods.join(', '), 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: `use ${methods.join(' or ')}` }))
      return
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const body = method === 'POST' ? await readJsonBody(request) : undefined
    const run = handler[method] ?? handler
    const result = await run({ query: url.searchParams, body, method, request })
    sendJson(response, 200, result)
  } catch (error) {
    const status = error instanceof HealthError ? 400 : 500
    log(`dsh-health: request failed: ${messageOf(error)}`)
    sendJson(response, status, {
      ok: false,
      code: error instanceof HealthError ? error.code : 'HEALTH_FAILED',
      error: messageOf(error)
    })
  }
}

function sendJson(response, status, payload) {
  const text = JSON.stringify(payload ?? { ok: true })
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  })
  response.end(text)
}

function readJsonBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new HealthError('request body too large', 'HEALTH_BODY_TOO_LARGE'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolvePromise(null)
        return
      }
      try {
        resolvePromise(JSON.parse(text))
      } catch (error) {
        rejectPromise(new HealthError(`body is not valid JSON: ${messageOf(error)}`, 'HEALTH_INVALID_JSON'))
      }
    })
    request.on('error', rejectPromise)
  })
}

/** Open a directory in the OS file manager, without shell interpolation. */
async function openPath(target, service) {
  const command = process.platform === 'win32'
    ? ['explorer.exe', [target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  await service.store.ensureLayout()
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
  child.unref()
}

// ----------------------------------------------------------------- shared ---

/** Every health tool returns this envelope; the model reads the JSON text. */
const HEALTH_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      error: { type: 'string' }
    }
  },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }]
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Merge a nested `value` object into the surrounding fields.
 * Flat keys win: an explicit top-level `date` should not be overwritten by a
 * stale `date` left inside `value`.
 */
function flattenValue(value, rest) {
  if (value === undefined || value === null) return rest
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HealthError('body.value must be an object when present', 'HEALTH_INVALID_BODY')
  }
  return { ...value, ...rest }
}

/** Exported for tests. */
export const internals = { resolveDataDir, withFlags, flattenValue }
