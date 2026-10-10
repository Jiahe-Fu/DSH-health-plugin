/**
 * Client-half tests.
 *
 * `client.js` is not an ES module: the Harness's Web loader evaluates it with a
 * `window.__ModuleLoader__` present and calls the registered factory. This test
 * provides exactly that surface, so a syntax error or a broken export is caught
 * here instead of as a blank slot in the running UI.
 *
 * The fake `require` returns a minimal React stand-in whose `createElement`
 * records the element tree. Rendering is not simulated — that needs a real
 * reconciler — but the plugin contract is: this file must register one
 * `settings.section` and must not throw on load.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

/** Minimal React surface the panel actually uses. */
function makeReactStub() {
  const calls = []
  const createElement = (type, props, ...children) => {
    calls.push({ type, props })
    return { type, props, children }
  }
  return {
    calls,
    React: {
      createElement,
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => undefined],
      useEffect: () => undefined,
      useCallback: (fn) => fn,
      useMemo: (fn) => fn()
    }
  }
}

/** Evaluate `client.js` against a loader stub and hand back its factory. */
async function loadClientFactory() {
  const source = await readFile(clientPath, 'utf8')
  let registered = null
  const documentStub = {
    getElementById: () => null,
    createElement: () => ({ set textContent(value) { this._text = value }, get textContent() { return this._text } }),
    head: { appendChild: () => undefined }
  }
  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        registered = entry
      }
    },
    document: documentStub
  }
  // Deliberately indirect so the source is evaluated as the browser would.
  const evaluate = new Function('window', 'document', 'fetch', source)
  evaluate(windowStub, documentStub, () => Promise.reject(new Error('no fetch in this test')))
  assert.ok(registered !== null, 'client.js must call window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-health-plugin', 'the lazy factory id must equal the package name')
  assert.equal(typeof registered.factory, 'function')
  return registered.factory
}

test('client: the module loader registration matches the package contract', async () => {
  const factory = await loadClientFactory()
  const { React } = makeReactStub()
  const plugin = factory((specifier) => {
    assert.equal(specifier, 'react', 'the only module the panel may require')
    return React
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

test('client: apply registers exactly one settings section and does not throw', async () => {
  const factory = await loadClientFactory()
  const { React } = makeReactStub()
  const plugin = factory(() => React)

  const registered = []
  const localeRegistrations = []
  let injections = 0
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        localeRegistrations.push({ namespace, dictionaries })
      },
      bind: () => (key) => `bound:${key}`
    },
    slots: {
      inject(owner, callback) {
        injections++
        assert.equal(owner, 'settings.section')
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => undefined
      }
    }
  }

  plugin.apply(ctx)

  assert.equal(injections, 1, 'one slot injection')
  assert.equal(registered.length, 1, 'one section registration')
  const section = registered[0]
  assert.equal(section.options.name, 'settings.section')
  assert.equal(section.options.id, 'health')
  assert.equal(typeof section.options.order, 'number')
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), 'bound:nav')
  assert.equal(typeof section.component, 'function', 'the section renders a component')

  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].namespace, 'settings.health')
  assert.ok(localeRegistrations[0].dictionaries.zh.nav.length > 0)
  assert.ok(localeRegistrations[0].dictionaries.en.nav.length > 0)
})

test('client: a locale failure must not cost us the panel', async () => {
  const factory = await loadClientFactory()
  const { React } = makeReactStub()
  const plugin = factory(() => React)

  const registered = []
  const ctx = {
    locale: {
      register() { throw new Error('namespace already taken') },
      bind() { throw new Error('unknown namespace') }
    },
    slots: {
      inject: (owner, callback) => callback(),
      register: (options) => { registered.push(options); return () => undefined }
    }
  }

  plugin.apply(ctx)
  assert.equal(registered.length, 1)
  // The label falls back to the built-in string rather than throwing.
  assert.equal(registered[0].label(), '健康')
})

test('client: rendering the panel produces an element tree without a live fetch', async () => {
  const factory = await loadClientFactory()
  const { React, calls } = makeReactStub()
  const plugin = factory(() => React)

  const registered = []
  plugin.apply({
    locale: undefined,
    slots: {
      inject: (owner, callback) => callback(),
      register: (options, component) => { registered.push(component); return () => undefined }
    }
  })

  const Panel = registered[0]
  const tree = Panel({})
  assert.ok(tree !== undefined && tree !== null, 'the panel returns a tree while loading')
  assert.ok(calls.length > 0, 'it used React.createElement')
  assert.ok(calls.some((call) => call.type === 'div'), 'it renders a container')
})

test('client: no Harness client package and no iframe is referenced', async () => {
  const source = await readFile(clientPath, 'utf8')
  // Strip comments first: the file explains this rule in prose, and the prose
  // itself must not trip the check.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.equal(/@deepseek-ai\/dsh-client/.test(code), false, 'must not import Harness Client packages')
  assert.equal(/<iframe|createElement\(['"]iframe/.test(code), false, 'must not render an iframe')
  assert.equal(/https?:\/\/(?!localhost)/.test(code), false, 'must not reach a remote origin')
})
