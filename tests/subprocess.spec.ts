import { fileURLToPath } from 'node:url'
import { join, resolve, dirname, basename } from 'node:path'
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
  return { argv: [process.execPath], cwd: process.cwd(), graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } }, ...extra }
}

describe('RunSeal subprocess lifecycle', () => {
  it('reuses one owner while cancellation, output and later executions stay independent', async () => {
    const ctx = await mount('shared')
    try {
      const first = ctx.subprocess.spawn(spec({ argv: [process.execPath, 'hold', 'first'] }))
      const second = ctx.subprocess.spawn(spec({ argv: [process.execPath, 'hold', 'second'] }))
      await expect.poll(() => first.collected.stdout!.readFrom(0).text).toContain('owner')
      await expect.poll(() => second.collected.stdout!.readFrom(0).text).toContain('owner')
      const a = JSON.parse(first.collected.stdout!.readFrom(0).text)
      const b = JSON.parse(second.collected.stdout!.readFrom(0).text)
      expect(a.owner).toBe(b.owner)
      expect(a.executionId).not.toBe(b.executionId)
      expect(a.argv).toContain('first')
      expect(b.argv).toContain('second')
      let secondFinished = false
      void second.done.then(() => { secondFinished = true })
      first.terminate()
      expect(await first.done).toMatchObject({ signal: 'SIGTERM' })
      expect(await first.waitForExit()).toBe(true)
      expect(secondFinished).toBe(false)
      const next = ctx.subprocess.spawn(spec())
      await next.done
      expect(JSON.parse(next.collected.stdout!.readFrom(0).text).owner).toBe(a.owner)
      second.terminate()
      await second.done
      await ctx.fiber.dispose()
      expect(() => process.kill(a.owner, 0)).toThrow()
    } finally { await ctx.fiber.dispose() }
  })

  it('does not share transport environments and replaces a lost owner', async () => {
    const ctx = await mount('shared')
    try {
      async function owner(env: Record<string, string>) {
        const handle = ctx.subprocess.spawn(spec({ env }))
        await handle.done
        return JSON.parse(handle.collected.stdout!.readFrom(0).text).owner as number
      }
      const first = await owner({ RUNSEAL_REUSE_TEST: 'a' })
      const other = await owner({ RUNSEAL_REUSE_TEST: 'b' })
      expect(other).not.toBe(first)
      expect(await owner({ RUNSEAL_REUSE_TEST: 'a' })).toBe(first)
      process.kill(first)
      await expect.poll(() => { try { process.kill(first, 0); return true } catch { return false } }).toBe(false)
      // A write racing owner loss may fail; never replay an execution whose admission is unknown.
      try { expect(await owner({ RUNSEAL_REUSE_TEST: 'a' })).not.toBe(first) }
      catch (error) { expect(String(error)).toMatch(/EPIPE|exited|destroyed/) }
      expect(await owner({ RUNSEAL_REUSE_TEST: 'a' })).not.toBe(first)
    } finally { await ctx.fiber.dispose() }
  })

  it('reports an unavailable runner as structured sandbox failure and proves no launch', async () => {
    const ctx = new Context()
    await ctx.plugin(Plugin, { command: join(process.cwd(), 'missing-runseal-4627'), autoSetup: false })
    try {
      const confined = await ctx.sandbox.confine([process.execPath], { mode: 'read-only', workspaceRoot: process.cwd() })
      const handle = ctx.subprocess.spawn(spec({ argv: confined.argv }))
      await expect(handle.done).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', cause: { code: 'ENOENT' } })
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('inherits the Electron Node selector only for host control workers and honors removal', async () => {
    const previous = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    const ctx = await mount('argv')
    try {
      for (const remove of [false, true]) {
        const handle = ctx.subprocess.spawn(spec({ env: remove ? { ELECTRON_RUN_AS_NODE: undefined } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'pipe', control: 'pipe' } }))
        await handle.done
        const request = JSON.parse(handle.collected.stdout!.readFrom(0).text)
        expect(request.env.ELECTRON_RUN_AS_NODE).toBe(remove ? undefined : '1')
      }
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = previous
      await ctx.fiber.dispose()
    }
  })
  it('resolves bare child commands using the execution PATH and retains arguments', async () => {
    const ctx = await mount('argv')
    try {
      const confined = await ctx.sandbox.confine([basename(process.execPath), 'argument with spaces'], { mode: 'read-only', workspaceRoot: process.cwd() })
      const handle = ctx.subprocess.spawn(spec({ argv: confined.argv, env: { PATH: dirname(process.execPath) }, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'pipe' } }))
      expect((await handle.done).exitCode).toBe(0)
      const request = JSON.parse(handle.collected.stdout!.readFrom(0).text)
      expect(request.command).toEqual([await ctx.subprocess.resolveExecutable(process.execPath), 'argument with spaces'])
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('classifies backend refusal without losing rejected-admission cleanup proof', async () => {
    const ctx = await mount('reject')
    try {
      const confined = await ctx.sandbox.confine([process.execPath], { mode: 'read-only', workspaceRoot: process.cwd() })
      const handle = ctx.subprocess.spawn(spec({ argv: confined.argv }))
      await expect(handle.done).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE', cause: { code: 'BACKEND_UNAVAILABLE' } })
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('retains executable-not-found instead of misreporting a missing child as sandbox failure', async () => {
    const ctx = await mount('argv')
    try {
      const confined = await ctx.sandbox.confine(['runseal-nonexistent-child-4627'], { mode: 'read-only', workspaceRoot: process.cwd() })
      const handle = ctx.subprocess.spawn(spec({ argv: confined.argv, env: { PATH: '' } }))
      await expect(handle.done).rejects.toMatchObject({ name: 'SubprocessExecutableNotFoundError' })
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it.skipIf(process.platform !== 'win32' || !process.env.LOCALAPPDATA)('keeps host setup identity when PTC removes child profile variables', async () => {
    const ctx = await mount('owner-env')
    try {
      const handle = ctx.subprocess.spawn(spec({ env: { LOCALAPPDATA: undefined, RUNSEAL_WINDOWS_SANDBOX_HOME: undefined } }))
      expect((await handle.done).exitCode).toBe(0)
      const data = JSON.parse(handle.collected.stdout!.readFrom(0).text)
      expect(data.local).toBeUndefined()
      expect(data.home).toBe(resolve(process.env.RUNSEAL_WINDOWS_SANDBOX_HOME
        ?? join(process.env.LOCALAPPDATA!, 'RunSeal', 'windows-sandbox')))
    } finally { await ctx.fiber.dispose() }
  })
  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('unwraps %s and streams input directly over RPC', async mode => {
    const ctx = await mount('echo')
    try {
      const confined = await ctx.sandbox.confine([process.execPath], { mode, workspaceRoot: process.cwd() })
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
  it('retries only rejected backpressure chunks without duplicating control bytes', async () => {
    const ctx = await mount('pressure')
    try {
      const handle = ctx.subprocess.spawn(spec({ stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' } }))
      const chunks: Buffer[] = []
      handle.control!.on('data', chunk => chunks.push(chunk))
      const bytes = Buffer.from('交互'.repeat(49152))
      await new Promise<void>((resolve, reject) => handle.control!.write(bytes, error => error ? reject(error) : resolve()))
      await expect.poll(() => Buffer.concat(chunks)).toEqual(bytes)
      handle.terminate()
      await handle.done
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
  it('cancels a write that remains backpressured and joins cleanup', async () => {
    const ctx = await mount('pressure-cancel')
    try {
      const handle = ctx.subprocess.spawn(spec({ stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: 'pipe', control: 'pipe' } }))
      handle.control!.write('pending', () => {})
      await expect.poll(() => handle.collected.stdout!.readFrom(0).text).toContain('PRESSURE_READY')
      handle.terminate()
      await handle.done
      expect(await handle.waitForExit()).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })
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
      await expect(ctx.subprocess.spawnTerminal({ argv: [process.execPath], cwd: process.cwd(), rows: 24, cols: 80,
        terminalType: 'xterm', graceMs: 1000, signal: AbortSignal.timeout(100) })).rejects.toThrow()
      await ctx.fiber.dispose()
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects terminal allocation without a native PID', async () => {
    const ctx = await mount('pty-no-pid')
    try {
      await expect(ctx.subprocess.spawnTerminal({ argv: [process.execPath], cwd: process.cwd(), rows: 24, cols: 80,
        terminalType: 'xterm', graceMs: 1000 })).rejects.toThrow('native process identity')
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects an accepted interrupt when execution ends without delivery', async () => {
    const ctx = await mount('pty-unconfirmed')
    try {
      const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath], cwd: process.cwd(), rows: 24, cols: 80,
        terminalType: 'xterm', graceMs: 1000 })
      await expect(terminal.signalForeground('SIGINT')).rejects.toThrow('before signal delivery')
      await terminal.terminate()
    } finally { await ctx.fiber.dispose() }
  })

  it('retains delivery proof when the terminal exits in the same RPC batch', async () => {
    const ctx = await mount('pty-exit-after-delivery')
    try {
      const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath], cwd: process.cwd(), rows: 24, cols: 80,
        terminalType: 'xterm', graceMs: 1000 })
      expect(await terminal.signalForeground('SIGINT')).toBe(process.platform === 'win32' ? 12345 : 23456)
      await terminal.terminate()
    } finally { await ctx.fiber.dispose() }
  })

  it('owns terminal startup, input, resize, interrupt and cleanup', async () => {
    const ctx = await mount('pty')
    const signal = new AbortController()
    try {
      const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath], cwd: process.cwd(), rows: 24, cols: 80, terminalType: 'xterm', graceMs: 1000, signal: signal.signal })
      let output = ''
      terminal.output.on('data', chunk => { output += chunk.toString() })
      signal.abort() // Allocation cancellation no longer owns the published terminal.
      // Browser Ctrl-C arrives as PTY input, not signalForeground(). Preserve ETX
      // so the console's processed/raw input mode determines its meaning.
      await terminal.write('\x03')
      await expect.poll(() => output).toBe('\x03')
      await terminal.write('你好')
      await Promise.all([terminal.write('A'.repeat(20000)), terminal.write('B'.repeat(20000))])
      await terminal.resize(100, 30)
      const interrupted = terminal.signalForeground('SIGINT')
      let delivered = false
      void interrupted.then(() => { delivered = true })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(delivered).toBe(false)
      expect(await interrupted).toBe(process.platform === 'win32' ? 12345 : 23456)
      await expect(terminal.signalForeground('SIGKILL')).rejects.toThrow('refusing')
      expect(await terminal.inspectActivity()).toMatchObject({ state: 'unknown' })
      expect(await terminal.inspectForeground()).toEqual(process.platform === 'win32' ? { processGroupId: 12345, inputWaiting: false } : undefined)
      expect(terminal.pid).toBe(12345)
      await expect.poll(() => output).toContain('你好' + 'A'.repeat(20000) + 'B'.repeat(20000) + 'resizeExecutionsignalExecution')
      expect(await terminal.signalForeground('SIGTERM')).toBe(12345)
      await terminal.terminate()
      await terminal.done
      await expect(terminal.write('late')).rejects.toThrow('closing')
    } finally { await ctx.fiber.dispose() }
  })
})
