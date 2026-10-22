import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const fake = fileURLToPath(new URL('./fake-runseal.cjs', import.meta.url))
async function mount(scenario: string) {
  const ctx = new Context()
  await ctx.plugin(Plugin, { command: process.execPath, args: [fake, scenario], autoSetup: false })
  return ctx
}
function spec(extra: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return { argv: ['unused'], cwd: process.cwd(), graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, ...extra }
}

describe('RunSeal subprocess lifecycle', () => {
  it('unwraps the sandbox spec and streams input directly over RPC', async () => {
    const ctx = await mount('echo')
    try {
      const confined = await ctx.sandbox.confine(['unused'], { mode: 'workspace-write', workspaceRoot: process.cwd() })
      const handle = ctx.subprocess.spawn(spec({ argv: confined.argv, stdio: { stdin: 'pipe', stdout: { maxBytes: 1024 }, stderr: 'pipe' } }))
      handle.stdin!.end('你好-rpc')
      expect(await handle.done).toEqual({ exitCode: 0, signal: null })
      expect(handle.collected.stdout!.readFrom(0).text).toBe('你好-rpc')
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('does not equate cancel acknowledgment with cleanup completion', async () => {
    const ctx = await mount('cancel-delayed')
    try {
      const handle = ctx.subprocess.spawn(spec())
      await expect.poll(() => handle.collected.stdout!.readFrom(0).text).toContain('READY')
      handle.terminate(); handle.terminate()
      expect(await handle.waitForExit(AbortSignal.timeout(30))).toBe(false)
      expect(await handle.done).toEqual({ exitCode: null, signal: 'SIGTERM' })
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('queues cancellation before the admission receipt without closing RPC', async () => {
    const ctx = await mount('cancel-early')
    try {
      const handle = ctx.subprocess.spawn(spec())
      handle.terminate()
      expect(await handle.done).toEqual({ exitCode: null, signal: 'SIGTERM' })
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('maps an AbortSignal onto protocol cancellation', async () => {
    const ctx = await mount('cancel')
    try {
      const abort = new AbortController()
      const handle = ctx.subprocess.spawn(spec({ signal: abort.signal }))
      await expect.poll(() => handle.collected.stdout!.readFrom(0).text).toContain('READY')
      abort.abort()
      expect(await handle.done).toMatchObject({ signal: 'SIGTERM' })
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('disposal cancels and joins all live executions', async () => {
    const ctx = await mount('cancel-delayed')
    const handles = [ctx.subprocess.spawn(spec()), ctx.subprocess.spawn(spec())]
    await expect.poll(() => handles.every(handle => handle.collected.stdout!.readFrom(0).text.includes('READY'))).toBe(true)
    await ctx.fiber.dispose()
    for (const handle of handles) {
      expect(await handle.done).toMatchObject({ signal: 'SIGTERM' })
      expect(await handle.waitForExit()).toBe(true)
    }
  })
  it('refuses to claim quiescence when terminal cleanup failed', async () => {
    const ctx = await mount('unclean')
    const handle = ctx.subprocess.spawn(spec())
    await expect(handle.done).rejects.toThrow('cleanup_complete')
    await expect(handle.waitForExit()).rejects.toThrow('cleanup_complete')
    await ctx.fiber.dispose()
    await expect(handle.waitForExit()).rejects.toThrow()
  })
  it('refuses to claim quiescence on connection loss before the receipt', async () => {
    const ctx = await mount('abrupt')
    const handle = ctx.subprocess.spawn(spec())
    await expect(handle.done).rejects.toThrow('exited')
    await expect(handle.waitForExit()).rejects.toThrow('exited')
    await ctx.fiber.dispose()
    await expect(handle.waitForExit()).rejects.toThrow()
  })
  it('keeps collection offsets, bounded tail and complete spill content', async () => {
    const ctx = await mount('output')
    try {
      const handle = ctx.subprocess.spawn(spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 3, spill: { maxBytes: 100 } }, stderr: { maxBytes: 1024 } } }))
      expect((await handle.done).exitCode).toBe(7)
      const read = handle.collected.stdout!.readFrom(0)
      expect(read).toMatchObject({ text: '好', nextOffset: 6, lossy: true })
      expect(await readFile(read.spillPath!, 'utf8')).toBe('你好')
      expect(handle.collected.stdout!.readFrom(6).text).toBe('')
    } finally { await ctx.fiber.dispose() }
  })
  it('validates pre-abort and reserved control environment before execution', async () => {
    const ctx = await mount('output')
    try {
      expect(() => ctx.subprocess.spawn(spec({ signal: AbortSignal.abort() }))).toThrow()
      expect(() => ctx.subprocess.spawn(spec({ env: { DSH_SUBPROCESS_CONTROL: 'pipe' } }))).toThrow('control-channel')
      expect(await ctx.subprocess.resolveExecutable(process.execPath)).toBeTruthy()
    } finally { await ctx.fiber.dispose() }
  })
})


describe('RunSeal interactive transports', () => {
  it('keeps control bytes separate and allows independent half-close', async () => {
    const ctx = await mount('control')
    try {
      const handle = ctx.subprocess.spawn(spec({ stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } }))
      const control: Buffer[] = [], stdout: Buffer[] = []
      handle.control!.on('data', chunk => control.push(chunk))
      handle.stdout!.on('data', chunk => stdout.push(chunk))
      handle.control!.end(Buffer.from([0, 255, 10, 13]))
      handle.stdin!.end('ordinary')
      await expect.poll(() => Buffer.concat(control)).toEqual(Buffer.from([0, 255, 10, 13]))
      expect(Buffer.concat(stdout).toString()).toBe('ordinary')
      handle.terminate()
      expect(await handle.waitForExit()).toBe(true)
      await handle.done
    } finally { await ctx.fiber.dispose() }
  })
  it('cancels pending terminal allocation and waits for protocol cleanup', async () => {
    const ctx = await mount('pty-preparing')
    try {
      await expect(ctx.subprocess.spawnTerminal({ argv: ['unused'], cwd: process.cwd(), rows: 24, cols: 80,
        terminalType: 'xterm', graceMs: 1000, signal: AbortSignal.timeout(100) })).rejects.toThrow()
      await ctx.fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('owns terminal startup, input, resize, interrupt and cleanup', async () => {
    const ctx = await mount('pty')
    const signal = new AbortController()
    try {
      const terminal = await ctx.subprocess.spawnTerminal({ argv: ['unused'], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'xterm', graceMs: 1000, signal: signal.signal })
      let output = ''
      terminal.output.on('data', chunk => { output += chunk.toString() })
      signal.abort() // Allocation cancellation no longer owns the published terminal.
      await terminal.write('你好')
      await Promise.all([terminal.write('A'.repeat(20000)), terminal.write('B'.repeat(20000))])
      await terminal.resize(100, 30)
      expect(await terminal.signalForeground('SIGINT')).toBeUndefined()
      await expect(terminal.signalForeground('SIGKILL')).rejects.toThrow('unsupported')
      expect(await terminal.inspectActivity()).toMatchObject({ state: 'unknown' })
      expect(await terminal.inspectForeground()).toBeUndefined()
      expect(terminal.pid).toBeUndefined()
      await expect.poll(() => output).toContain('你好' + 'A'.repeat(20000) + 'B'.repeat(20000) + 'resizeExecutionsignalExecution')
      await terminal.terminate()
      await terminal.done
      await expect(terminal.write('late')).rejects.toThrow('closing')
    } finally { await ctx.fiber.dispose() }
  })
})
