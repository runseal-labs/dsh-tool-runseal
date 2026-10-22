import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

it('ships a browser factory that registers the RunSeal configuration against its profile namespace', () => {
  const require = createRequire(import.meta.url)
  let registration: { id: string; factory: (require: NodeRequire) => { apply: (ctx: unknown) => void } } | undefined
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } },
  })
  expect(registration?.id).toBe('dsh-tool-runseal')
  const slots: unknown[] = []
  registration!.factory(require).apply({
    configForms: { get: (namespace: string) => { expect(namespace).toBe('sandbox-runseal'); return {} } },
    slots: {
      inject: (_: string, callback: () => void) => callback(),
      register: (options: unknown, component: unknown) => { slots.push(options); expect(typeof component).toBe('function') },
    },
  })
  expect(slots).toEqual([{ name: 'plugins.bundle.config', key: 'dsh-tool-runseal' }])
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(manifest.exports['./client'].default).toBe('./lib/client.js')
})
