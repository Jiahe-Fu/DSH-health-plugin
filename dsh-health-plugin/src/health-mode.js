/**
 * Session-scoped health mode.
 *
 * `/health` is a human command, not a tool call, so it must not require a model
 * turn to take effect. The flag therefore lives here and is read by the prompt
 * section that runs before each model step, which means one command changes how
 * the very next message is handled.
 *
 * It is keyed by the live `Agent` object rather than by session id: the flag is
 * process-local, and an agent that is disposed and later resumed simply starts
 * with the mode off, which is the honest default. Nothing about health mode is
 * written to the session log, so it cannot silently apply to a session the user
 * did not switch on.
 */

/** @type {WeakMap<object, boolean>} */
const modes = new WeakMap()

/** @type {Set<() => void>} */
const listeners = new Set()

/** Whether health mode is on for this agent. */
export function isHealthMode(agent) {
  if (agent === null || typeof agent !== 'object') return false
  return modes.get(agent) === true
}

/** Set the flag and notify observers. Returns the new value. */
export function setHealthMode(agent, enabled) {
  if (agent === null || typeof agent !== 'object') {
    throw new TypeError('health mode needs an agent')
  }
  const next = enabled === true
  modes.set(agent, next)
  for (const listener of listeners) {
    try {
      listener(agent, next)
    } catch {
      // A bad observer must not break the toggle itself.
    }
  }
  return next
}

/** Flip the flag and return the new value. */
export function toggleHealthMode(agent) {
  return setHealthMode(agent, !isHealthMode(agent))
}

/**
 * Observe toggles. The prompt section uses this so a change can invalidate its
 * cached text instead of waiting for some unrelated event.
 *
 * @param {(agent: object, enabled: boolean) => void} listener
 */
export function onHealthModeChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** How many live agents currently have health mode on (diagnostics and tests). */
export function healthModeCount(agents) {
  let count = 0
  for (const agent of agents) {
    if (isHealthMode(agent)) count++
  }
  return count
}

/**
 * The two prompt texts for one agent.
 *
 * Health mode adds a short imperative block rather than swapping the whole
 * section: the archive rules stay identical either way, so the prompt prefix
 * stays cacheable and only the mode line changes.
 */
export function modeText(enabled) {
  if (enabled) {
    return [
      '健康模式：**已开启**。',
      '本轮起按私人健康顾问的方式工作：先看档案再给建议，睡眠优先，'
      + '涉及用药时用 drug_notes 取成文说明，缺数据就说缺数据。'
    ].join('')
  }
  return [
    '健康模式：未开启。',
    '仍然可以记录与查询健康数据（用户直接说数据时就记），但不要主动展开健康建议、'
    + '不要按健康顾问的口吻回答。用户输入 /health 可开启。'
  ].join('')
}
