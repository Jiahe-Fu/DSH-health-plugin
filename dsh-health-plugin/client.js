/**
 * dsh-health — Client half (Web panel).
 *
 * Renders one Settings page, "健康", registered into `settings.section`. It is
 * a plain-JS module in the shape the Client module loader expects: a lazy
 * factory whose id equals the package name, receiving `require` for the
 * browser's own module table (React comes from there).
 *
 * Deliberate constraints, all of them load-bearing:
 *   - No import of any `@deepseek-ai/dsh-client-*` package. Those change
 *     without notice and a throwing component blanks the slot.
 *   - No iframe: an iframe document never receives the host's theme tokens or
 *     locale, so the panel would look like a foreign application.
 *   - Every colour comes from a `--dsw-alias-*` / `--dsw-specific-*` token.
 *   - All data comes from the plugin's own `/api/health/*` routes, which sit in
 *     front of the same service the agent tools use.
 *
 * Sleep leads the page on purpose: it is the primary lever, so it gets the
 * first card, the only chart, and the only write form in this version.
 */

window.__ModuleLoader__.load({
  id: 'dsh-health-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'dshh'

    /**
     * Candidate API prefixes, most preferred first.
     *
     * Deliberately probed rather than hardcoded. A panel that pins one prefix
     * keeps calling a path that no longer exists after the plugin moves, and the
     * only symptom is "invalid JSON ... not found" — an unhelpfully indirect way
     * to learn that a route moved. Probing also keeps a stale bundle working,
     * because the route that does exist is discovered instead of assumed.
     *
     * `/api` is not a candidate: that prefix belongs to the host's RPC channel,
     * which answers unknown paths with a plain-text `not found`, so a route of
     * ours could never be reached there.
     */
    const API_CANDIDATES = ['/dsh-health']

    let apiBase = null
    let apiBaseProbe = null

    /** Resolve once, then cache for the life of the page. */
    function resolveApiBase() {
      if (apiBase !== null) return Promise.resolve(apiBase)
      if (apiBaseProbe !== null) return apiBaseProbe
      apiBaseProbe = (async () => {
        for (const candidate of API_CANDIDATES) {
          try {
            const response = await fetch(`${candidate}/status`, { headers: { accept: 'application/json' } })
            if (!response.ok) continue
            const payload = await response.json()
            // The shape check matters: a host that answers an unknown path with
            // something JSON-shaped must not be mistaken for this plugin.
            if (payload?.ok === true && payload?.paths?.root !== undefined) {
              apiBase = candidate
              return candidate
            }
          } catch {
            // Fall through to the next candidate.
          }
        }
        throw new Error('找不到健康插件接口：宿主侧可能未加载 dsh-health，或路由前缀已变更')
      })()
      return apiBaseProbe
    }

    // ------------------------------------------------------------ styles ---

    const STYLE_ID = `${NS}-styles`
    if (typeof document !== 'undefined' && document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.${NS}-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 32px; color: var(--dsw-alias-label-primary); }
.${NS}-row { display: flex; align-items: center; gap: 8px; }
.${NS}-row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.${NS}-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }
.${NS}-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 14px 16px; }
.${NS}-card-title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.${NS}-grid { display: grid; gap: 12px; }
.${NS}-grid-4 { grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
.${NS}-grid-2 { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.${NS}-stat { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 10px 12px; }
.${NS}-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.${NS}-stat-value { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.${NS}-stat-unit { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-secondary); margin-left: 3px; }
.${NS}-stat-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.${NS}-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 5px 11px; font-size: 12px; cursor: pointer; font-family: inherit; }
.${NS}-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.${NS}-btn:disabled { opacity: .5; cursor: default; }
.${NS}-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.${NS}-btn-icon { padding: 3px 7px; font-size: 12px; line-height: 1; }
.${NS}-field { display: flex; flex-direction: column; gap: 4px; }
.${NS}-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.${NS}-input, .${NS}-select { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; padding: 5px 8px; font-size: 12px; color: var(--dsw-alias-label-primary); font-family: inherit; width: 100%; box-sizing: border-box; }
.${NS}-input:focus, .${NS}-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.${NS}-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 10px; align-items: end; }
.${NS}-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.${NS}-tab { border: none; background: none; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 6px 10px;
  cursor: pointer; border-bottom: 2px solid transparent; font-family: inherit; }
.${NS}-tab[data-active="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.${NS}-flag { display: inline-block; font-size: 11px; border-radius: 4px; padding: 1px 6px; margin: 2px 4px 0 0;
  border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.${NS}-flag-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.${NS}-flag-sample { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.${NS}-source-banner { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.6;
  border-left: 2px solid var(--dsw-alias-state-warn-primary); padding-left: 10px; }
.${NS}-refusal { border-left: 2px solid var(--dsw-alias-state-warn-primary); padding-left: 10px; margin: 6px 0; font-size: 12px; line-height: 1.6; }
.${NS}-list { display: flex; flex-direction: column; }
.${NS}-item { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.${NS}-item:last-child { border-bottom: none; }
.${NS}-item-date { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex: 0 0 74px; }
.${NS}-item-summary { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.${NS}-pill { font-size: 10px; color: var(--dsw-alias-label-secondary); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px; padding: 0 6px; }
.${NS}-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); padding: 10px 0; }
.${NS}-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; }
.${NS}-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; }
.${NS}-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.${NS}-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.${NS}-bar-track { fill: var(--dsw-alias-bg-layer-2); }
.${NS}-goal-line { stroke: var(--dsw-alias-label-secondary); stroke-width: 1; stroke-dasharray: 3 3; opacity: .8; }
.${NS}-axis { fill: var(--dsw-alias-label-secondary); font-size: 9px; }
.${NS}-plan { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.${NS}-plan-big { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.${NS}-rules { margin: 8px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary); }
.${NS}-collapse { font-size: 12px; }
.${NS}-collapse > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); }
`
      document.head.appendChild(style)
    }

    // --------------------------------------------------------- formatting ---

    const pad2 = (n) => String(n).padStart(2, '0')

    /** `YYYY-MM-DD` for the local clock. */
    function localToday() {
      const now = new Date()
      return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
    }

    /** Minutes as `7h20m`, or `—` when absent. */
    function hm(minutes) {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—'
      const total = Math.round(minutes)
      const hours = Math.floor(total / 60)
      const rest = total % 60
      return hours > 0 ? `${hours}h${pad2(rest)}m` : `${rest}m`
    }

    function clockOf(minutes) {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—'
      const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
      return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`
    }

    function percent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${Math.round(value * 100)}%`
    }

    function number(value, digits = 1) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toFixed(digits).replace(/\.0+$/, '')
    }

    /** Efficiency buckets, used for both the chart colour and the legend. */
    function efficiencyTone(efficiency) {
      if (typeof efficiency !== 'number' || !Number.isFinite(efficiency)) return 'var(--dsw-alias-state-idle-primary)'
      if (efficiency >= 0.9) return 'var(--dsw-alias-state-success-primary)'
      if (efficiency >= 0.85) return 'var(--dsw-alias-brand-primary)'
      if (efficiency >= 0.75) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-error-primary)'
    }

    // ------------------------------------------------------------ fetching ---

    /**
     * Turn a plugin-relative path (`/status`) into a real URL by resolving the
     * API base first. Every request goes through here, so no caller has to know
     * the prefix.
     */
    async function apiUrl(path) {
      const base = await resolveApiBase()
      return `${base}${path}`
    }

    /** GET one API route, surfacing the server's own error message. */
    async function getJson(path, signal) {
      const url = await apiUrl(path)
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
      const text = await response.text()
      let payload
      try {
        payload = text.length > 0 ? JSON.parse(text) : {}
      } catch {
        throw new Error(`invalid JSON from ${url}: ${text.slice(0, 200)}`)
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `${response.status} ${response.statusText}`)
      }
      return payload
    }

    /** POST JSON to one API route. */
    async function postJson(path, body) {
      const url = await apiUrl(path)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {})
      })
      const text = await response.text()
      let payload
      try {
        payload = text.length > 0 ? JSON.parse(text) : {}
      } catch {
        throw new Error(`invalid JSON from ${url}: ${text.slice(0, 200)}`)
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `${response.status} ${response.statusText}`)
      }
      return payload
    }

    /** Small data hook: load on mount and on every `reload` call. */
    function useApi(path, deps) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const [nonce, setNonce] = useState(0)

      useEffect(() => {
        const controller = new AbortController()
        let live = true
        setState((previous) => ({ status: previous.data === null ? 'loading' : 'refreshing', data: previous.data, error: null }))
        getJson(path, controller.signal)
          .then((data) => {
            if (live) setState({ status: 'ready', data, error: null })
          })
          .catch((error) => {
            if (live && error?.name !== 'AbortError') {
              setState({ status: 'error', data: null, error: error.message })
            }
          })
        return () => {
          live = false
          controller.abort()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [path, nonce, ...(deps ?? [])])

      const reload = useCallback(() => setNonce((n) => n + 1), [])
      return { ...state, reload }
    }

    // ------------------------------------------------------------ widgets ---

    function Stat({ label, value, unit, sub }) {
      return h('div', { className: `${NS}-stat` },
        h('div', { className: `${NS}-stat-label` }, label),
        h('div', { className: `${NS}-stat-value` },
          value,
          unit ? h('span', { className: `${NS}-stat-unit` }, unit) : null),
        sub ? h('div', { className: `${NS}-stat-sub` }, sub) : null)
    }

    /**
     * Night-by-night total sleep time, with the goal line and the efficiency
     * tone. Hand-rolled SVG: no chart library is available to a plain-JS
     * plugin, and the panel must not reach for a CDN.
     */
    function SleepChart({ series, needMin }) {
      const usable = (series ?? []).filter((day) => day.date)
      const width = 640
      const height = 150
      const padding = { top: 12, right: 10, bottom: 30, left: 38 }
      const plotWidth = width - padding.left - padding.right
      const plotHeight = height - padding.top - padding.bottom
      const values = usable.map((day) => day.tstMin).filter((value) => typeof value === 'number')
      const scaleMax = Math.max(needMin + 60, ...(values.length > 0 ? values : [needMin + 60]))
      const slot = usable.length > 0 ? plotWidth / usable.length : plotWidth
      const barWidth = Math.max(3, Math.min(26, slot - 4))

      const y = (minutes) => padding.top + plotHeight - (minutes / scaleMax) * plotHeight

      if (values.length === 0) {
        return h('div', { className: `${NS}-empty` }, '这个窗口内还没有睡眠记录。记满 7 晚就能看出趋势。')
      }

      return h('div', null,
        h('svg', {
          viewBox: `0 0 ${width} ${height}`,
          width: '100%',
          height: 'auto',
          role: 'img',
          'aria-label': '每晚总睡眠时间与睡眠效率'
        },
        // goal line
        h('line', {
          className: `${NS}-goal-line`,
          x1: padding.left, x2: width - padding.right,
          y1: y(needMin), y2: y(needMin)
        }),
        h('text', { className: `${NS}-axis`, x: 2, y: y(needMin) + 3 }, `${(needMin / 60).toFixed(1)}h`),
        h('text', { className: `${NS}-axis`, x: 2, y: y(scaleMax) + 10 }, `${(scaleMax / 60).toFixed(0)}h`),
        h('text', { className: `${NS}-axis`, x: 2, y: y(0) + 3 }, '0'),
        ...usable.map((day, index) => {
          const minutes = day.tstMin
          const x = padding.left + index * slot + (slot - barWidth) / 2
          if (typeof minutes !== 'number') {
            return h('rect', {
              key: day.date,
              className: `${NS}-bar-track`,
              x, y: padding.top + plotHeight - 2, width: barWidth, height: 2, rx: 1
            })
          }
          return h('rect', {
            key: day.date,
            x,
            y: y(minutes),
            width: barWidth,
            height: Math.max(1, padding.top + plotHeight - y(minutes)),
            rx: 2,
            fill: efficiencyTone(day.efficiency),
            // Native tooltip keeps this dependency-free and keyboard-agnostic;
            // the accessible label carries the same information.
            'aria-label': `${day.date} 睡眠 ${hm(minutes)}，效率 ${percent(day.efficiency)}`
          }, h('title', null, `${day.date}\n睡眠 ${hm(minutes)}\n卧床 ${hm(day.tibMin)}\n效率 ${percent(day.efficiency)}\n入睡耗时 ${hm(day.solMin)}\n夜醒 ${hm(day.wasoMin)}`))
        }),
        // date ticks: first, middle, last only, to avoid a cramped axis
        ...[0, Math.floor(usable.length / 2), usable.length - 1]
          .filter((index, position, list) => index >= 0 && list.indexOf(index) === position)
          .map((index) => h('text', {
            key: `tick-${index}`,
            className: `${NS}-axis`,
            x: padding.left + index * slot + slot / 2,
            y: height - 10,
            textAnchor: index === 0 ? 'start' : (index === usable.length - 1 ? 'end' : 'middle')
          }, usable[index].date.slice(5)))
      ),
        h('div', { className: `${NS}-legend`, style: { marginTop: 6 } },
          h('span', null, h('i', { className: `${NS}-swatch`, style: { background: 'var(--dsw-alias-state-success-primary)' } }), '效率 ≥90%'),
          h('span', null, h('i', { className: `${NS}-swatch`, style: { background: 'var(--dsw-alias-brand-primary)' } }), '85–90%'),
          h('span', null, h('i', { className: `${NS}-swatch`, style: { background: 'var(--dsw-alias-state-warn-primary)' } }), '75–85%'),
          h('span', null, h('i', { className: `${NS}-swatch`, style: { background: 'var(--dsw-alias-state-error-primary)' } }), '<75%'),
          h('span', null, '虚线 = 同龄参考需求')))
    }

    /** Sleep midpoints on a 24 h dial: the phase-drift view. */
    function MidpointStrip({ series }) {
      const points = (series ?? [])
        .map((day) => ({ date: day.date, midpoint: day.midpointMin }))
        .filter((point) => typeof point.midpoint === 'number')
      if (points.length < 3) return null

      const width = 640
      const height = 46
      const padding = { left: 38, right: 10, top: 8, bottom: 18 }
      const plotWidth = width - padding.left - padding.right
      // Centre the dial on 03:00 so a normal schedule sits in the middle.
      const centre = 3 * 60
      const span = 300
      const scaleX = (minutes) => {
        let delta = ((minutes - centre) % 1440 + 1440) % 1440
        if (delta > 720) delta -= 1440
        const clamped = Math.max(-span, Math.min(span, delta))
        return padding.left + plotWidth / 2 + (clamped / span) * (plotWidth / 2)
      }
      const scaleY = (index) => padding.top + (points.length <= 1 ? 0 : (index / (points.length - 1)) * (height - padding.top - padding.bottom))

      return h('div', null,
        h('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 'auto', role: 'img', 'aria-label': '睡眠中点漂移' },
          ...[0, 1, 2, 3, 4, 5].map((hour) => h('line', {
            key: `grid-${hour}`,
            x1: padding.left + (plotWidth / 5) * hour,
            x2: padding.left + (plotWidth / 5) * hour,
            y1: padding.top,
            y2: height - padding.bottom,
            stroke: 'var(--dsw-alias-border-l1)',
            'stroke-width': 1
          })),
          ...[1, 3, 5].map((hour) => h('text', {
            key: `label-${hour}`,
            className: `${NS}-axis`,
            x: padding.left + plotWidth / 2 + ((hour - 3) * 60 / span) * (plotWidth / 2),
            y: height - 5,
            textAnchor: 'middle'
          }, `${pad2(hour)}:00`)),
          h('polyline', {
            fill: 'none',
            stroke: 'var(--dsw-alias-brand-primary)',
            'stroke-width': 1.5,
            points: points.map((point, index) => `${scaleX(point.midpoint)},${scaleY(index)}`).join(' ')
          }),
          ...points.map((point, index) => h('circle', {
            key: point.date,
            cx: scaleX(point.midpoint),
            cy: scaleY(index),
            r: 2.5,
            fill: 'var(--dsw-alias-brand-primary)'
          }, h('title', null, `${point.date} 睡眠中点 ${clockOf(point.midpoint)}`)))),
        h('div', { className: `${NS}-muted` }, '睡眠中点（入睡与醒来之间的中点）连线：左右摆动越大，昼夜节律相位越不稳定。'))
    }

    function Flags({ flags }) {
      if (!Array.isArray(flags) || flags.length === 0) return null
      return h('div', null, ...flags.map((flag, index) => h('span', {
        key: index,
        className: `${NS}-flag ${/立即|急症|自杀|自伤/.test(flag) ? `${NS}-flag-error` : ''}`
      }, flag)))
    }

    /**
     * Where a value came from.
     *
     * A health record is only trustworthy if the panel says so: a demo entry
     * that looks exactly like the user's own report is worse than no entry,
     * because it silently changes what every average and trend means.
     */
    function SourceBadge({ record }) {
      if (record?.sample === true) {
        return h('span', { className: `${NS}-flag ${NS}-flag-sample`, title: '这条不是你记录的真实数据，可以一键清除' },
          record.sourceLabel ?? '示例数据')
      }
      if (typeof record?.sourceLabel === 'string' && record.sourceLabel.length > 0) {
        return h('span', { className: `${NS}-pill` }, record.sourceLabel)
      }
      return null
    }

    // ----------------------------------------------------------- sections ---

    /** The write form. Only sleep, because sleep is the lever. */
    function SleepForm({ date, onDone }) {
      const [form, setForm] = useState({
        date: date,
        bedtime: '23:00',
        out_of_bed: '07:00',
        sleep_onset_min: '',
        waso_min: '',
        quality: '',
        note: ''
      })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [ok, setOk] = useState(null)

      const set = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }))

      const submit = async (event) => {
        event.preventDefault()
        setBusy(true)
        setError(null)
        setOk(null)
        try {
          const body = {
            date: form.date,
            bedtime: form.bedtime,
            out_of_bed: form.out_of_bed
          }
          if (form.sleep_onset_min !== '') body.sleep_onset_min = Number(form.sleep_onset_min)
          if (form.waso_min !== '') body.waso_min = Number(form.waso_min)
          if (form.quality !== '') body.quality = Number(form.quality)
          if (form.note.trim() !== '') body.note = form.note.trim()
          // Typed into this form by the user, so the record is theirs by
          // definition. The agent tools default to 'agent' instead, which keeps
          // "the user told me" and "I typed it" distinguishable in the archive.
          body.source = 'user'
          const result = await postJson(`/sleep-log`, body)
          setOk(result.summary ?? '已记录')
          onDone?.()
        } catch (submitError) {
          setError(submitError.message)
        } finally {
          setBusy(false)
        }
      }

      const field = (key, label, type, extra) => h('label', { className: `${NS}-field` },
        h('span', { className: `${NS}-field-label` }, label),
        h('input', {
          className: `${NS}-input`,
          type: type ?? 'text',
          value: form[key],
          onChange: set(key),
          ...extra
        }))

      return h('form', { className: `${NS}-form`, onSubmit: submit },
        field('date', '醒来日期', 'date'),
        field('bedtime', '上床时间', 'time'),
        field('out_of_bed', '起床时间', 'time'),
        field('sleep_onset_min', '入睡耗时(分)', 'number', { min: 0, step: 5, placeholder: '如 25' }),
        field('waso_min', '夜醒合计(分)', 'number', { min: 0, step: 5, placeholder: '如 30' }),
        field('quality', '主观质量 1-5', 'number', { min: 1, max: 5, step: 1 }),
        h('label', { className: `${NS}-field`, style: { gridColumn: '1 / -1' } },
          h('span', { className: `${NS}-field-label` }, '备注（咖啡因 / 酒精 / 屏幕 / 其他）'),
          h('input', { className: `${NS}-input`, value: form.note, onChange: set('note'), placeholder: '如 18:30 咖啡 120mg；23:10 关屏' })),
        h('div', { className: `${NS}-row`, style: { gridColumn: '1 / -1' } },
          h('button', { className: `${NS}-btn ${NS}-btn-primary`, type: 'submit', disabled: busy },
            busy ? '记录中…' : '记录这一晚'),
          ok !== null ? h('span', { className: `${NS}-muted` }, `已保存：${ok}`) : null,
          error !== null ? h('span', { className: `${NS}-error` }, error) : null))
    }

    /** Summary card: last night, and the week behind it. */
    function SleepSection({ dashboard, onChanged }) {
      const [showForm, setShowForm] = useState(false)
      const analysis = dashboard?.sleep?.analysis
      const plan = dashboard?.sleep?.plan
      const lastNight = dashboard?.lastNight

      const refusals = plan?.safety?.refusals ?? []
      const blocking = refusals.filter((refusal) => refusal.code.startsWith('red-flag') || refusal.code.startsWith('contraindication'))

      return h('div', { className: `${NS}-root` },
        h('div', { className: `${NS}-row-between` },
          h('div', { className: `${NS}-card-title` }, '睡眠'),
          h('div', { className: `${NS}-row` },
            h('button', { className: `${NS}-btn`, onClick: () => setShowForm((open) => !open) },
              showForm ? '收起' : '记录昨晚'),
            h('button', { className: `${NS}-btn`, onClick: onChanged, title: '重新读取' }, '刷新'))),

        showForm ? h('div', { className: `${NS}-card` }, h(SleepForm, { date: dashboard?.today ?? localToday(), onDone: () => { setShowForm(false); onChanged?.() } })) : null,

        h('div', { className: `${NS}-grid ${NS}-grid-4` },
          h(Stat, {
            label: '昨晚睡眠',
            value: lastNight ? hm(lastNight.tstMin) : '—',
            sub: lastNight ? `${lastNight.date} · 卧床 ${hm(lastNight.tibMin)}` : '还没有记录'
          }),
          h(Stat, {
            label: '睡眠效率',
            value: lastNight ? percent(lastNight.efficiency) : '—',
            sub: '目标 ≥90%'
          }),
          h(Stat, {
            label: '入睡耗时',
            value: lastNight ? hm(lastNight.sleepOnsetMin) : '—',
            sub: '目标 <30m'
          }),
          h(Stat, {
            label: '近 7 晚睡眠负债',
            value: analysis ? hm(analysis.debt?.debtMin) : '—',
            sub: analysis ? `记录 ${analysis.debt?.nightsCounted ?? 0} 晚 · 需求 ${hm(analysis.needMin)}` : null
          })),

        h('div', { className: `${NS}-card` },
          h('div', { className: `${NS}-row-between` },
            h('div', { className: `${NS}-card-title` }, '每晚总睡眠时间'),
            h('div', { className: `${NS}-muted` }, `近 ${dashboard?.window?.days ?? 30} 天`)),
          h(SleepChart, { series: dashboard?.sleep?.series ?? [], needMin: analysis?.needMin ?? 480 }),
          h(MidpointStrip, { series: dashboard?.sleep?.series ?? [] })),

        h('div', { className: `${NS}-grid ${NS}-grid-2` },
          h('div', { className: `${NS}-card` },
            h('div', { className: `${NS}-card-title` }, '平均指标'),
            h('div', { className: `${NS}-grid ${NS}-grid-4`, style: { marginTop: 10 } },
              h(Stat, { label: '总睡眠', value: hm(analysis?.mean?.tstMin) }),
              h(Stat, { label: '卧床', value: hm(analysis?.mean?.tibMin) }),
              h(Stat, { label: '夜醒', value: hm(analysis?.mean?.wasoMin) }),
              h(Stat, { label: '睡眠中点', value: analysis?.phase?.midpointMeanClock ?? '—', sub: analysis?.phase?.spreadMin != null ? `波动 ${analysis.phase.spreadMin}m` : null })),
            analysis?.insomniaScreen ? h('div', { className: `${NS}-muted`, style: { marginTop: 10 } },
              `失眠模式筛查：${analysis.insomniaScreen.label}（受影响 ${analysis.insomniaScreen.affectedNights} 晚 / ${analysis.insomniaScreen.spanDays} 天，约每周 ${analysis.insomniaScreen.nightsPerWeek} 次）。${analysis.insomniaScreen.note}`) : null),

          h('div', { className: `${NS}-card` },
            h('div', { className: `${NS}-card-title` }, 'CBT-I 建议窗口'),
            plan ? h('div', { className: `${NS}-plan`, style: { marginTop: 10 } },
              h('div', null,
                h('div', { className: `${NS}-stat-label` }, '固定起床'),
                h('div', { className: `${NS}-plan-big` }, plan.plan?.targetWake ?? '—')),
              h('div', null,
                h('div', { className: `${NS}-stat-label` }, '目标上床'),
                h('div', { className: `${NS}-plan-big` }, plan.plan?.targetBed ?? '—')),
              h('div', null,
                h('div', { className: `${NS}-stat-label` }, '卧床时长'),
                h('div', { className: `${NS}-plan-big` }, hm(plan.plan?.prescribedTibMin)))) : null,
            plan ? h('div', { className: `${NS}-muted`, style: { marginTop: 8 } }, plan.plan?.reason ?? '') : null,
            blocking.length > 0
              ? h('div', null,
                h('div', { className: `${NS}-muted`, style: { marginTop: 8, fontWeight: 600 } }, '以下情况会阻止行为方案，需先处理：'),
                ...blocking.map((refusal, index) => h('div', { key: index, className: `${NS}-refusal` }, refusal.message)))
              : null,
            plan?.plan?.rules?.length > 0
              ? h('ul', { className: `${NS}-rules` }, ...plan.plan.rules.map((rule, index) => h('li', { key: index }, rule)))
              : null,
            plan?.safetyNotice ? h('div', { className: `${NS}-muted`, style: { marginTop: 8 } }, plan.safetyNotice) : null),

          analysis?.warnings?.length > 0
            ? h('div', { className: `${NS}-card` },
              h('div', { className: `${NS}-card-title` }, '值得注意'),
              h('ul', { className: `${NS}-rules` }, ...analysis.warnings.map((warning, index) => h('li', { key: index }, warning))))
            : null,

          analysis?.correlations
            ? h('div', { className: `${NS}-card` },
              h('div', { className: `${NS}-card-title` }, '行为相关性'),
              h('div', { className: `${NS}-muted`, style: { marginTop: 6 } },
                '以下是记录内的统计相关，不是因果，样本也小：'),
              h('ul', { className: `${NS}-rules` },
                ...[
                  ['咖啡因→入睡耗时', analysis.correlations.caffeineToOnset],
                  ['酒精→入睡耗时', analysis.correlations.alcoholToOnset],
                  ['关屏提前量→入睡耗时', analysis.correlations.screensToOnset],
                  ['总睡眠→主观质量', analysis.correlations.tstToQuality]
                ].map(([label, entry], index) => h('li', { key: index },
                  `${label}：${entry?.r == null ? '—' : `r=${entry.r}`}（n=${entry?.n ?? 0}）${entry?.note ?? ''}`))))
            : null)
      )
    }

    /** Today's records and the recent window. */
    function RecordsSection({ dashboard, onChanged }) {
      const [pending, setPending] = useState(null)
      const [error, setError] = useState(null)
      const [clearing, setClearing] = useState(false)
      // The sample banner needs the full list, not just today's records.
      const { data } = useApi(`/records?limit=200`)

      const clearSamples = async () => {
        setClearing(true)
        setError(null)
        try {
          const result = await postJson(`/clear-samples`, {})
          onChanged?.()
          setError(null)
          // Surfaced through the refreshed banner rather than a toast.
          void result
        } catch (clearError) {
          setError(clearError.message)
        } finally {
          setClearing(false)
        }
      }

      const remove = async (id) => {
        setPending(id)
        setError(null)
        try {
          await postJson(`/delete`, { id })
          onChanged?.()
        } catch (removeError) {
          setError(removeError.message)
        } finally {
          setPending(null)
        }
      }

      const today = dashboard?.todayRecords ?? []
      const flagged = dashboard?.summary?.flagged ?? []
      const recent = data?.records ?? []
      const sampleCount = recent.filter((record) => record.sample === true).length

      return h('div', { className: `${NS}-root` },
        error !== null ? h('div', { className: `${NS}-error` }, error) : null,
        sampleCount > 0
          ? h('div', { className: `${NS}-card ${NS}-source-banner` },
            h('div', null,
              h('div', { style: { fontWeight: 600 } }, `档案里有 ${sampleCount} 条示例数据`),
              h('div', { className: `${NS}-muted` }, '它们不是你的真实记录，但会参与平均值与趋势计算。建议清除后再开始记录。')),
            h('button', { className: `${NS}-btn`, onClick: clearSamples, disabled: clearing }, clearing ? '清除中…' : '清除全部示例数据'))
          : null,
        h('div', { className: `${NS}-card` },
          h('div', { className: `${NS}-row-between` },
            h('div', { className: `${NS}-card-title` }, `${dashboard?.today ?? ''} 的记录`),
            h('span', { className: `${NS}-pill` }, `${today.length} 条`)),
          today.length === 0
            ? h('div', { className: `${NS}-empty` }, '今天还没有记录。也可以在对话里直接说，例如「今天体重 70.4，睡了 6 小时」。')
            : h('div', { className: `${NS}-list` }, ...today.map((record) => h('div', { key: record.id, className: `${NS}-item` },
              h('span', { className: `${NS}-item-date` }, record.kind),
              h('span', { className: `${NS}-item-summary` }, record.summary, h(Flags, { flags: record.flags })),
              h(SourceBadge, { record }),
              h('button', {
                className: `${NS}-btn ${NS}-btn-icon`,
                disabled: pending === record.id,
                onClick: () => remove(record.id),
                title: '删除这条记录'
              }, '删除'))))),

        flagged.length > 0
          ? h('div', { className: `${NS}-card` },
            h('div', { className: `${NS}-card-title` }, '近期需要留意的读数'),
            h('div', { className: `${NS}-list` }, ...flagged.map((entry, index) => h('div', { key: index, className: `${NS}-item` },
              h('span', { className: `${NS}-item-date` }, entry.date),
              h('span', { className: `${NS}-item-summary` }, entry.summary, h(Flags, { flags: entry.flags }))))))
          : null,

        h('div', { className: `${NS}-card` },
          h('div', { className: `${NS}-card-title` }, '最近记录'),
          h(RecentList, { reload: onChanged })))
    }

    /**
     * The full record list.
     *
     * It loads its own copy rather than reusing the dashboard payload, because
     * the dashboard only carries today's records; the caller's `reload` is
     * wired in so deleting a row refreshes both views.
     */
    function RecentList({ reload: reloadParent }) {
      const { status, data, error, reload } = useApi(`/records?limit=60`)
      const refresh = useCallback(() => {
        reload()
        reloadParent?.()
      }, [reload, reloadParent])
      if (status === 'loading') return h('div', { className: `${NS}-empty` }, '读取中…')
      if (status === 'error') return h('div', { className: `${NS}-error` }, error)
      const records = data?.records ?? []
      if (records.length === 0) return h('div', { className: `${NS}-empty` }, '还没有任何记录。')
      return h('div', null,
        h('div', { className: `${NS}-muted`, style: { marginBottom: 6 } }, `共 ${data.total} 条，显示最近 ${records.length} 条`),
        h('div', { className: `${NS}-list` }, ...records.map((record) => h('div', { key: record.id, className: `${NS}-item` },
          h('span', { className: `${NS}-item-date` }, record.date),
          h('span', { className: `${NS}-item-summary` }, record.summary, h(Flags, { flags: record.flags })),
          h(SourceBadge, { record }),
          h('span', { className: `${NS}-pill` }, record.kind)))),
        h('div', { className: `${NS}-row`, style: { marginTop: 8 } },
          h('button', { className: `${NS}-btn`, onClick: reload }, '重新读取')))
    }

    /** Profile editing: the fields that change what the sleep plan will do. */
    function ProfileSection({ onChanged }) {
      const { status, data, error, reload } = useApi(`/profile`)
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [saved, setSaved] = useState(false)

      useEffect(() => {
        if (data?.profile !== undefined && form === null) {
          const profile = data.profile ?? {}
          setForm({
            birthYear: profile.birthYear ?? '',
            heightCm: profile.heightCm ?? '',
            targetWake: profile.targetWake ?? '',
            conditions: Array.isArray(profile.conditions) ? profile.conditions.join('、') : '',
            medications: Array.isArray(profile.medications) ? profile.medications.join('、') : '',
            occupation: profile.occupation ?? ''
          })
        }
      }, [data, form])

      const set = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }))

      const save = async (event) => {
        event.preventDefault()
        setBusy(true)
        setSaveError(null)
        setSaved(false)
        try {
          const patch = {}
          if (form.birthYear !== '') patch.birthYear = Number(form.birthYear)
          if (form.heightCm !== '') patch.heightCm = Number(form.heightCm)
          if (form.targetWake !== '') patch.targetWake = form.targetWake
          if (form.occupation !== '') patch.occupation = form.occupation
          patch.conditions = form.conditions === '' ? [] : form.conditions.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
          patch.medications = form.medications === '' ? [] : form.medications.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
          await postJson(`/profile`, patch)
          setSaved(true)
          reload()
          onChanged?.()
        } catch (saveFailure) {
          setSaveError(saveFailure.message)
        } finally {
          setBusy(false)
        }
      }

      if (status === 'loading') return h('div', { className: `${NS}-empty` }, '读取中…')
      if (status === 'error') return h('div', { className: `${NS}-error` }, error)
      if (form === null) return h('div', { className: `${NS}-empty` }, '准备中…')

      const field = (key, label, placeholder) => h('label', { className: `${NS}-field` },
        h('span', { className: `${NS}-field-label` }, label),
        h('input', { className: `${NS}-input`, value: form[key], onChange: set(key), placeholder }))

      return h('div', { className: `${NS}-root` },
        h('div', { className: `${NS}-muted` },
          '这份档案决定睡眠方案的安全边界：疾病史与职业会触发禁忌筛查，目标起床时间是整个方案的锚点。明文保存在本机。'),
        h('form', { className: `${NS}-card` },
          h('div', { className: `${NS}-form` },
            field('birthYear', '出生年份', '1998'),
            field('heightCm', '身高 (cm)', '175'),
            field('targetWake', '目标起床时间', '06:40'),
            field('occupation', '职业（是否为驾驶/机械操作）', '如 学生 / 货车司机'),
            h('label', { className: `${NS}-field`, style: { gridColumn: '1 / -1' } },
              h('span', { className: `${NS}-field-label` }, '疾病史（顿号或逗号分隔；双相情感障碍、癫痫等情况会阻止睡眠限制疗法）'),
              h('input', { className: `${NS}-input`, value: form.conditions, onChange: set('conditions'), placeholder: '如 高血压、双相情感障碍' })),
            h('label', { className: `${NS}-field`, style: { gridColumn: '1 / -1' } },
              h('span', { className: `${NS}-field-label` }, '长期用药'),
              h('input', { className: `${NS}-input`, value: form.medications, onChange: set('medications'), placeholder: '如 氨氯地平' })),
            h('div', { className: `${NS}-row`, style: { gridColumn: '1 / -1' } },
              h('button', { className: `${NS}-btn ${NS}-btn-primary`, type: 'submit', disabled: busy }, busy ? '保存中…' : '保存档案'),
              saved ? h('span', { className: `${NS}-muted` }, '已保存') : null,
              saveError !== null ? h('span', { className: `${NS}-error` }, saveError) : null))),
        h(DataSection))
    }

    /** Where the data lives, and how to get out of it. */
    function DataSection() {
      const { status, data, error } = useApi(`/status`)
      const [message, setMessage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [exportHref, setExportHref] = useState(null)

      useEffect(() => {
        let live = true
        apiUrl('/export')
          .then((url) => { if (live) setExportHref(url) })
          .catch(() => undefined)
        return () => { live = false }
      }, [])

      const openFolder = async () => {
        setBusy(true)
        setMessage(null)
        try {
          const result = await postJson(`/open-folder`, {})
          setMessage(`已请求打开：${result.opened}`)
        } catch (openError) {
          setMessage(openError.message)
        } finally {
          setBusy(false)
        }
      }

      if (status === 'loading') return h('div', { className: `${NS}-empty` }, '读取中…')
      if (status === 'error') return h('div', { className: `${NS}-error` }, error)

      return h('div', { className: `${NS}-card` },
        h('div', { className: `${NS}-card-title` }, '数据与隐私'),
        h('div', { className: `${NS}-muted`, style: { marginTop: 8 } },
          '全部数据是这台机器上的明文文件，插件本身不发任何网络请求。'),
        h('div', { className: `${NS}-mono`, style: { marginTop: 6 } }, data?.paths?.root ?? ''),
        h('div', { className: `${NS}-muted`, style: { marginTop: 8 } },
          `今年已记录 ${data?.recordsThisYear ?? 0} 条。`,
          data?.profileCorrupt === true ? ' ⚠ profile.json 无法解析，已保留原文件，请手工检查。' : '',
          (data?.skippedLines?.length ?? 0) > 0 ? ` ⚠ 有 ${data.skippedLines.length} 行记录无法解析，已跳过而未被删除。` : ''),
        h('div', { className: `${NS}-muted`, style: { marginTop: 8 } },
          '注意：本地存储不等于隐私。在对话里讨论这些数据时，内容会作为提示词发送给模型提供商。'),
        h('div', { className: `${NS}-row`, style: { marginTop: 10 } },
          h('button', { className: `${NS}-btn`, onClick: openFolder, disabled: busy }, busy ? '打开中…' : '打开数据目录'),
          // A plain anchor needs a literal href, so the resolved base is kept in
          // state for it rather than fetched on click.
          h('a', {
            className: `${NS}-btn`,
            href: exportHref ?? '#',
            target: '_blank',
            rel: 'noreferrer',
            download: 'dsh-health-export.json',
            style: { textDecoration: 'none' },
            'aria-disabled': exportHref === null ? 'true' : undefined
          }, '导出 JSON'),
          message !== null ? h('span', { className: `${NS}-muted` }, message) : null))
    }

    /**
     * Written notes for one drug, loaded only when the user opens them.
     *
     * The notes are the reason this tab exists: restrictions, monitoring, and
     * the red flags that mean call someone. Two sources are possible and they
     * are shown differently on purpose — the plugin's curated notes, and quoted
     * web passages with their links — so a reader can always tell which one they
     * are looking at.
     */
    function DrugNotes({ name }) {
      const { status, data, error } = useApi(`/drug?name=${encodeURIComponent(name)}`)
      if (status === 'loading') return h('div', { className: `${NS}-empty` }, '读取中…')
      if (status === 'error') return h('div', { className: `${NS}-error` }, error)

      const web = data?.web
      const webBlock = web === undefined ? null : h('div', { className: `${NS}-card`, style: { marginTop: 10 } },
        h('div', { className: `${NS}-stat-label`, style: { fontWeight: 600 } }, '联网检索（非成文说明）'),
        h('div', { className: `${NS}-muted`, style: { marginTop: 4 } }, web.note),
        Array.isArray(web.passages) && web.passages.length > 0
          ? h('ul', { className: `${NS}-rules`, style: { marginTop: 6 } },
            ...web.passages.map((passage, index) => h('li', { key: index },
              h('div', null, passage.text),
              h('a', {
                className: `${NS}-muted`,
                href: passage.url,
                target: '_blank',
                rel: 'noreferrer',
                style: { display: 'block', marginTop: 2 }
              }, `来源：${passage.title ?? passage.url}`))))
          : null,
        Array.isArray(web.sources) && web.sources.length > 0
          ? h('div', { style: { marginTop: 8 } },
            h('div', { className: `${NS}-stat-label` }, '检索到的页面'),
            ...web.sources.map((source, index) => h('a', {
              key: index,
              className: `${NS}-muted`,
              href: source.url,
              target: '_blank',
              rel: 'noreferrer',
              style: { display: 'block', marginTop: 2 }
            }, `${source.trusted === true ? '✓ ' : ''}${source.title ?? source.url}`)))
          : null)

      if (data?.known !== true) {
        return h('div', null,
          h('div', { className: `${NS}-muted` },
            '本插件的成文条目里**没有这个药**。剂量与注意事项请以说明书和医生/药师交代为准；'
            + '你登记的提醒仍会按时发出，因为提醒只依赖处方本身。'),
          webBlock)
      }

      const drug = data.drugs[0]
      const block = (title, items, render) => (Array.isArray(items) && items.length > 0
        ? h('div', { style: { marginTop: 10 } },
          h('div', { className: `${NS}-stat-label`, style: { fontWeight: 600, marginBottom: 4 } }, title),
          h('ul', { className: `${NS}-rules` }, ...items.map((item, index) => h('li', { key: index }, render(item)))))
        : null)

      const severity = (entry) => (entry.severity === 'absolute' ? '禁' : entry.severity === 'avoid' ? '避' : '注')

      return h('div', { style: { marginTop: 8 } },
        h('div', { className: `${NS}-muted` }, `${drug.drugClass} · ${drug.usedFor}`),
        drug.intake ? h('div', { className: `${NS}-card`, style: { marginTop: 8 } },
          h('div', { className: `${NS}-stat-label`, style: { fontWeight: 600 } }, '服法要点'),
          h('div', { style: { marginTop: 4 } }, drug.intake.foodNote),
          h('div', { className: `${NS}-muted` }, drug.intake.splitting),
          drug.intake.timingNote ? h('div', { className: `${NS}-muted`, style: { marginTop: 4 } }, drug.intake.timingNote) : null
        ) : null,
        block('忌口与禁忌', drug.restrictions, (entry) => h('span', null,
          h('span', { className: `${NS}-flag` }, severity(entry)), ` ${entry.text}`)),
        block('常见不良反应', drug.sideEffects, (entry) => entry.text),
        block('需要做的事', drug.supportiveCare, (entry) => entry.text),
        block('需要复查的项目', drug.monitoring, (entry) => entry.text),
        block('出现这些要就医', drug.redFlags, (entry) => entry.text),
        drug.evidenceNote
          ? h('div', { className: `${NS}-card`, style: { marginTop: 10 } },
            h('div', { className: `${NS}-stat-label`, style: { fontWeight: 600 } }, '证据强度'),
            h('div', { style: { marginTop: 4 } }, drug.evidenceNote),
            drug.productVariability ? h('div', { className: `${NS}-muted`, style: { marginTop: 4 } }, drug.productVariability) : null)
          : null,
        h('div', { className: `${NS}-muted`, style: { marginTop: 10 } }, drug.prescriberOfRecord),
        // Every curated claim names where it came from, so the reader can check
        // it rather than trust the plugin.
        Array.isArray(drug.references) && drug.references.length > 0
          ? h('div', { style: { marginTop: 8 } },
            h('div', { className: `${NS}-stat-label` }, '事实依据（延伸阅读）'),
            ...drug.references.map((source, index) => h('div', { key: index, style: { marginTop: 2 } },
              h('a', { className: `${NS}-muted`, href: source.url, target: '_blank', rel: 'noreferrer' }, source.label),
              source.note ? h('span', { className: `${NS}-muted` }, `（${source.note}）`) : null)))
          : null,
        webBlock)
    }

    /**
     * The medication tab: what is being taken, when, and what to watch for.
     */
    function MedicationsSection({ onChanged }) {
      const { status, data, error, reload } = useApi(`/medications`)
      const [open, setOpen] = useState(null)
      const [form, setForm] = useState({
        name: '', dose: '', unitsPerDose: '', formulation: 'softgel',
        frequency: 'twice_daily', times: '08:00, 20:00', withFood: 'must', notes: ''
      })
      const [busy, setBusy] = useState(false)
      const [formError, setFormError] = useState(null)
      const [formOk, setFormOk] = useState(null)

      const set = (key) => (event) => setForm((previous) => ({ ...previous, [key]: event.target.value }))

      const submit = async (event) => {
        event.preventDefault()
        setBusy(true)
        setFormError(null)
        setFormOk(null)
        try {
          const body = {
            name: form.name.trim(),
            formulation: form.formulation,
            frequency: form.frequency,
            withFood: form.withFood
          }
          if (form.dose.trim() !== '') body.dose = form.dose.trim()
          if (form.unitsPerDose !== '') body.unitsPerDose = Number(form.unitsPerDose)
          if (form.notes.trim() !== '') body.notes = form.notes.trim()
          if (form.frequency.endsWith('daily') || form.frequency === 'three_times_daily') {
            body.times = form.times.split(/[,，]/).map((value) => value.trim()).filter(Boolean)
          }
          const result = await postJson(`/medication`, body)
          setFormOk(`已登记 ${result.medication.name}`)
          setForm((previous) => ({ ...previous, name: '', dose: '', unitsPerDose: '', notes: '' }))
          reload()
          onChanged?.()
        } catch (submitError) {
          setFormError(submitError.message)
        } finally {
          setBusy(false)
        }
      }

      const remove = async (id) => {
        setBusy(true)
        setFormError(null)
        try {
          await postJson(`/medication/delete`, { id })
          reload()
          onChanged?.()
        } catch (removeError) {
          setFormError(removeError.message)
        } finally {
          setBusy(false)
        }
      }

      if (status === 'loading') return h('div', { className: `${NS}-empty` }, '读取中…')
      if (status === 'error') return h('div', { className: `${NS}-error` }, error)

      const medications = data?.medications ?? []

      return h('div', { className: `${NS}-root` },
        h('div', { className: `${NS}-card` },
          h('div', { className: `${NS}-card-title` }, '正在服用的药'),
          h('div', { className: `${NS}-muted`, style: { marginTop: 6 } },
            '这里登记的是**处方本身**——药名、剂量、次数、时间。剂量与疗程以医生交代为准，'
            + '面板只负责记录与提醒，不会替你决定吃几颗。'),
          data?.corrupt === true
            ? h('div', { className: `${NS}-error`, style: { marginTop: 8 } },
              'medications.json 无法解析。原文件已保留，请手工检查，面板不会覆盖它。')
            : null,
          medications.length === 0
            ? h('div', { className: `${NS}-empty` }, '还没有登记任何长期用药。也可以在对话里说，例如「医生让我吃异维A酸，一天两颗，早晚各一次」。')
            : h('div', { className: `${NS}-list`, style: { marginTop: 8 } }, ...medications.map((entry) => h('div', { key: entry.id, style: { borderBottom: `1px solid var(--dsw-alias-border-l1)`, padding: '8px 0' } },
              h('div', { className: `${NS}-row-between` },
                h('div', null,
                  h('div', { style: { fontWeight: 600 } },
                    entry.name,
                    entry.dose ? h('span', { className: `${NS}-muted` }, ` ${entry.dose}`) : null,
                    entry.unitsPerDose ? h('span', { className: `${NS}-pill`, style: { marginLeft: 6 } }, `${entry.unitsPerDose} 粒/片`) : null),
                  h('div', { className: `${NS}-muted` },
                    [
                      entry.times?.length ? entry.times.join(' / ') : null,
                      entry.frequency,
                      entry.withFood === 'must' ? '随餐' : entry.withFood === 'empty_stomach' ? '空腹' : null,
                      entry.startDate ? `自 ${entry.startDate}` : null
                    ].filter(Boolean).join(' · '))),
                h('div', { className: `${NS}-row` },
                  h('button', {
                    className: `${NS}-btn`,
                    onClick: () => setOpen(open === entry.id ? null : entry.id)
                  }, open === entry.id ? '收起说明' : '看说明'),
                  h('button', {
                    className: `${NS}-btn ${NS}-btn-icon`,
                    disabled: busy,
                    onClick: () => remove(entry.id),
                    title: '删除这条用药登记'
                  }, '删除'))),
              h('ul', { className: `${NS}-rules`, style: { marginTop: 4 } },
                ...entry.essentials.map((line, index) => h('li', { key: index }, line))),
              open === entry.id ? h(DrugNotes, { name: entry.name }) : null)))),

        h('form', { className: `${NS}-card`, onSubmit: submit },
          h('div', { className: `${NS}-card-title` }, '登记一种药'),
          h('div', { className: `${NS}-form`, style: { marginTop: 10 } },
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '药名'),
              h('input', { className: `${NS}-input`, value: form.name, onChange: set('name'), placeholder: '如 异维A酸' })),
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '单片剂量'),
              h('input', { className: `${NS}-input`, value: form.dose, onChange: set('dose'), placeholder: '如 10mg' })),
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '每次几粒'),
              h('input', { className: `${NS}-input`, type: 'number', min: 1, value: form.unitsPerDose, onChange: set('unitsPerDose'), placeholder: '如 2' })),
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '剂型'),
              h('select', { className: `${NS}-select`, value: form.formulation, onChange: set('formulation') },
                h('option', { value: 'softgel' }, '软胶囊'),
                h('option', { value: 'capsule' }, '胶囊'),
                h('option', { value: 'tablet' }, '片剂'),
                h('option', { value: 'sustained_release' }, '缓释片'),
                h('option', { value: 'enteric' }, '肠溶片'),
                h('option', { value: 'solution' }, '溶液'))),
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '频次'),
              h('select', { className: `${NS}-select`, value: form.frequency, onChange: set('frequency') },
                h('option', { value: 'once_daily' }, '每日一次'),
                h('option', { value: 'twice_daily' }, '每日两次'),
                h('option', { value: 'three_times_daily' }, '每日三次'),
                h('option', { value: 'every_other_day' }, '隔日一次'),
                h('option', { value: 'weekly' }, '每周'),
                h('option', { value: 'as_needed' }, '按需'),
                h('option', { value: 'custom' }, '其他'))),
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '服药时间（逗号分隔）'),
              h('input', { className: `${NS}-input`, value: form.times, onChange: set('times'), placeholder: '08:00, 20:00' })),
            h('label', { className: `${NS}-field` },
              h('span', { className: `${NS}-field-label` }, '与食物'),
              h('select', { className: `${NS}-select`, value: form.withFood, onChange: set('withFood') },
                h('option', { value: 'must' }, '必须随餐'),
                h('option', { value: 'either' }, '都可以'),
                h('option', { value: 'empty_stomach' }, '空腹'))),
            h('label', { className: `${NS}-field`, style: { gridColumn: '1 / -1' } },
              h('span', { className: `${NS}-field-label` }, '医嘱备注'),
              h('input', { className: `${NS}-input`, value: form.notes, onChange: set('notes'), placeholder: '如 与早餐同服；医生说先吃一个月复查' })),
            h('div', { className: `${NS}-row`, style: { gridColumn: '1 / -1' } },
              h('button', { className: `${NS}-btn ${NS}-btn-primary`, type: 'submit', disabled: busy }, busy ? '保存中…' : '登记'),
              formOk !== null ? h('span', { className: `${NS}-muted` }, formOk) : null,
              formError !== null ? h('span', { className: `${NS}-error` }, formError) : null))),

        h('div', { className: `${NS}-card` },
          h('div', { className: `${NS}-muted` },
            '提醒需要在对话里创建（Agent 会用 schedule 按你登记的时间发提醒）。'
            + '登记完可以直接说「按这个时间给我设提醒」。')))
    }

    // ------------------------------------------------------------ the page ---
    const TABS = [
      { id: 'sleep', label: '睡眠' },
      { id: 'meds', label: '用药' },
      { id: 'records', label: '记录' },
      { id: 'profile', label: '档案与数据' }
    ]

    function HealthPanel() {
      const [tab, setTab] = useState('sleep')
      const dashboard = useApi(`/dashboard?days=30`)

      if (dashboard.status === 'loading') return h('div', { className: `${NS}-root` }, h('div', { className: `${NS}-empty` }, '正在读取健康档案…'))
      if (dashboard.status === 'error') {
        return h('div', { className: `${NS}-root` },
          h('div', { className: `${NS}-card` },
            h('div', { className: `${NS}-card-title` }, '无法读取健康数据'),
            h('div', { className: `${NS}-error`, style: { marginTop: 8 } }, dashboard.error),
            h('div', { className: `${NS}-row`, style: { marginTop: 10 } },
              h('button', { className: `${NS}-btn`, onClick: dashboard.reload }, '重试'))))
      }

      const data = dashboard.data
      return h('div', { className: `${NS}-root` },
        h('div', { className: `${NS}-tabs` }, ...TABS.map((entry) => h('button', {
          key: entry.id,
          className: `${NS}-tab`,
          'data-active': String(tab === entry.id),
          onClick: () => setTab(entry.id)
        }, entry.label))),
        tab === 'sleep' ? h(SleepSection, { dashboard: data, onChanged: dashboard.reload }) : null,
        tab === 'meds' ? h(MedicationsSection, { onChanged: dashboard.reload }) : null,
        tab === 'records' ? h(RecordsSection, { dashboard: data, onChanged: dashboard.reload }) : null,
        tab === 'profile' ? h(ProfileSection, { onChanged: dashboard.reload }) : null)
    }

    // ------------------------------------------------------------- plugin ---

    /** Localized strings for the Settings navigation entry. */
    const zh = { nav: '健康', title: '健康', description: '本地健康档案：睡眠优先的 CBT-I 方案、记录与趋势。' }
    const en = { nav: 'Health', title: 'Health', description: 'Local health archive: sleep-first CBT-I coaching, records, and trends.' }

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        if (ctx.locale?.register) {
          try {
            ctx.locale.register('settings.health', { zh, en })
          } catch {
            // A locale conflict must never cost us the panel.
          }
        }

        const label = () => {
          try {
            return ctx.locale.bind('settings.health')('nav')
          } catch {
            return zh.nav
          }
        }

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'health',
          order: 60,
          label,
          locale: 'settings.health'
        }, HealthPanel))
      }
    }
  }
})
