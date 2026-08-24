import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'

async function loadClientPlugin() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const nodeRequire = createRequire(resolve(new URL('../package.json', import.meta.url).pathname))
  const require = (id) => {
    // React is a host-provided platform module. The test does not render a
    // component, so a minimal platform stub keeps this runtime contract test
    // independent from the optional browser package installation.
    if (id === 'react') return { createElement() {}, useState() {}, useSyncExternalStore() {} }
    if (id === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: {} }
    return nodeRequire(id)
  }
  let plugin
  vm.runInNewContext(source, {
    console,
    process,
    Symbol,
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(require) } } },
  })
  return plugin
}

function createClientContext() {
  const registrations = []
  const sidebarTabs = []
  const sidebarDisposals = []
  const slots = {
    inject(_name, callback) { callback() },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const ctx = new Context()
  ctx.provide('slots', slots)
  ctx.provide('locale', {})
  ctx.provide('connection', { rpc: { call() {} } })
  ctx.provide('remote', {})
  ctx.provide('settingsScope', {
    bind() {
      return {
        getSnapshot: () => ({ status: 'unavailable', writable: false }),
        subscribe: () => () => {},
        async set() {},
      }
    },
  })
  return { ctx, registrations, sidebarTabs, sidebarDisposals }
}

test('core applies without betterSidebar while optional child remains inactive', async () => {
  const plugin = await loadClientPlugin()
  const state = createClientContext()
  plugin.apply(state.ctx)
  assert.equal(state.registrations.length, 3)
  assert.equal(state.sidebarTabs.length, 0)
  assert.equal(state.ctx.get('betterSidebar', false), undefined)
})

test('optional child follows provider arrival and removal', async () => {
  const plugin = await loadClientPlugin()
  const state = createClientContext()
  plugin.apply(state.ctx)
  assert.equal(state.sidebarTabs.length, 0)

  const provider = await state.ctx.plugin({
    name: 'late-better-sidebar-provider',
    apply(ctx) {
      ctx.provide('betterSidebar', {
        registerTab(tab) {
          state.sidebarTabs.push(tab)
          return () => state.sidebarDisposals.push(tab.id)
        },
        openTab() {},
      })
    },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(state.sidebarTabs.length, 1)

  await provider.dispose()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(state.sidebarDisposals, ['oks:context'])
})

test('parent plugin disposal removes the optional Sidebar registration', async () => {
  const plugin = await loadClientPlugin()
  const state = createClientContext()
  const provider = await state.ctx.plugin({
    name: 'parent-disposal-better-sidebar-provider',
    apply(ctx) {
      ctx.provide('betterSidebar', {
        registerTab(tab) {
          state.sidebarTabs.push(tab)
          return () => state.sidebarDisposals.push(tab.id)
        },
        openTab() {},
      })
    },
  })
  const parent = await state.ctx.plugin({
    name: 'dsh-oks-parent-test',
    inject: plugin.inject,
    apply: plugin.apply,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(state.sidebarTabs.length, 1)

  await parent.dispose()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(state.sidebarDisposals, ['oks:context'])
  await provider.dispose()
})

test('optional child registers the Sidebar tab when provider is active', async () => {
  const plugin = await loadClientPlugin()
  const state = createClientContext()
  await state.ctx.plugin({
    name: 'test-better-sidebar-provider',
    apply(ctx) {
      ctx.provide('betterSidebar', {
        registerTab(tab) {
          state.sidebarTabs.push(tab)
          return () => {}
        },
        openTab() {},
      })
    },
  })
  plugin.apply(state.ctx)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(state.registrations.length, 3)
  assert.equal(state.sidebarTabs.length, 1)
  assert.equal(state.sidebarTabs[0].id, 'oks:context')
})
