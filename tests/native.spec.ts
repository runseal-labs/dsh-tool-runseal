import { mkdtemp, mkdir, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'

const binary = process.env.RUNSEAL_TEST_BINARY

describe.skipIf(!binary)('native RunSeal through dsh services', () => {
  it('preserves cwd, streams stdin, enforces write roots and terminates an active execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runseal-test-'))
    const workspace = join(root, 'workspace')
    const cwd = join(workspace, 'nested')
    await mkdir(cwd, { recursive: true })
    const ctx = new Context()
    await ctx.plugin(Plugin, { command: resolve(binary!), autoSetup: false, timeoutMs: 10000 })
    async function start(code: string, mode: 'read-only' | 'workspace-write', stdin = '') {
      const confined = await ctx.sandbox.confine([process.execPath, '-e', code], { mode, workspaceRoot: workspace })
      return ctx.subprocess.spawn({ argv: confined.argv, cwd, graceMs: 2000,
        stdio: { stdin: { data: stdin }, stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
    }
    try {
      const echo = await start('process.stdout.write(process.cwd()+"\\n");process.stdin.pipe(process.stdout)', 'read-only', 'native-你好')
      const echoOutcome = await echo.done
      expect(echoOutcome.exitCode, echo.collected.stderr!.readFrom(0).text).toBe(0)
      expect(echo.collected.stdout!.readFrom(0).text.toLowerCase()).toBe((cwd + '\nnative-你好').toLowerCase())
      const writable = join(workspace, 'allowed.txt')
      const write = await start(`require('node:fs').writeFileSync(${JSON.stringify(writable)},'ok')`, 'workspace-write')
      const writeOutcome = await write.done
      expect(writeOutcome.exitCode, write.collected.stderr!.readFrom(0).text).toBe(0)
      expect(await readFile(writable, 'utf8')).toBe('ok')
      for (const [mode, target] of [['read-only', join(workspace, 'denied.txt')], ['workspace-write', join(root, 'outside.txt')]] as const) {
        const denied = await start(`require('node:fs').writeFileSync(${JSON.stringify(target)},'bad')`, mode)
        expect((await denied.done).exitCode).not.toBe(0)
        await expect(access(target)).rejects.toThrow()
      }
      const running = await start('console.log("READY");setInterval(()=>{},1000)', 'read-only')
      await expect.poll(() => running.collected.stdout!.readFrom(0).text, { timeout: 10000 }).toContain('READY')
      running.terminate()
      await running.done
      expect(await running.waitForExit(AbortSignal.timeout(10000))).toBe(true)
      // Process exit alone is insufficient: a new admission must still work.
      const afterCancel = await start('console.log("after-cancel")', 'read-only')
      const afterCancelOutcome = await afterCancel.done
      expect(afterCancelOutcome.exitCode, afterCancel.collected.stderr!.readFrom(0).text).toBe(0)
      const abort = new AbortController()
      const raw = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'console.log("READY");setInterval(()=>{},1000)'], cwd,
        signal: abort.signal, graceMs: 2000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
      await expect.poll(() => raw.collected.stdout!.readFrom(0).text, { timeout: 10000 }).toContain('READY')
      abort.abort()
      expect((await raw.done).signal).toBe('SIGTERM')
      expect(await raw.waitForExit()).toBe(true)
      const disposing = await start('console.log("READY");setInterval(()=>{},1000)', 'read-only')
      await expect.poll(() => disposing.collected.stdout!.readFrom(0).text, { timeout: 10000 }).toContain('READY')
      await ctx.fiber.dispose()
      expect(await disposing.waitForExit()).toBe(true)
      const fresh = new Context()
      await fresh.plugin(Plugin, { command: resolve(binary!), autoSetup: false })
      try {
        const confined = await fresh.sandbox.confine([process.execPath, '-e', 'console.log("after-dispose")'], { mode: 'read-only', workspaceRoot: workspace })
        const next = fresh.subprocess.spawn({ argv: confined.argv, cwd, graceMs: 2000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
        expect((await next.done).exitCode).toBe(0)
        expect(next.collected.stdout!.readFrom(0).text).toContain('after-dispose')
      } finally { await fresh.fiber.dispose() }
    } finally {
      await ctx.fiber.dispose()
      const childPath = relative(resolve(tmpdir()), resolve(root))
      expect(childPath && !childPath.startsWith('..') && !isAbsolute(childPath), 'safe test cleanup path').toBeTruthy()
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
})


describe.skipIf(!binary)('native terminal and control transports', () => {
  it('uses native fd 7 under every provider policy and joins terminal cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runseal-interactive-'))
    const ctx = new Context()
    await ctx.plugin(Plugin, { command: resolve(binary!), autoSetup: false, timeoutMs: 20000 })
    const controlModule = pathToFileURL(process.env.DSH_SOURCE_ROOT ? resolve(process.env.DSH_SOURCE_ROOT, 'packages/subprocess/subprocess/src/control.ts') : createRequire(import.meta.url).resolve('@deepseek-ai/dsh-subprocess/control')).href
    try {
      for (const mode of ['unrestricted', 'read-only', 'workspace-write'] as const) {
        const code = `import {openInheritedControlChannel} from ${JSON.stringify(controlModule)}; const c=openInheritedControlChannel(); let data=Buffer.alloc(0); c.on('data',b=>{data=Buffer.concat([data,b]); if(data.length===98304) c.write(data,()=>{console.log('CONTROL_DONE'); c.destroy()})}); process.stdin.pipe(process.stdout)`
        const argv = [process.execPath, '--input-type=module', '-e', code]
        const wrapped = mode !== 'unrestricted' ? (await ctx.sandbox.confine(argv, { mode, workspaceRoot: root })).argv : argv
        const handle = ctx.subprocess.spawn({ argv: wrapped, cwd: root, graceMs: 2000,
          stdio: { stdin: 'pipe', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 }, control: 'pipe' } })
        const chunks: Buffer[] = []
        handle.control!.on('data', chunk => chunks.push(chunk))
        const bytes = Buffer.from(Array.from({ length: 98304 }, (_, i) => i % 256))
        handle.control!.end(bytes)
        handle.stdin!.end('STDIN_ONLY')
        const outcome = await handle.done
        expect(outcome.exitCode, handle.collected.stderr!.readFrom(0).text).toBe(0)
        expect(Buffer.concat(chunks)).toEqual(bytes)
        expect(handle.collected.stdout!.readFrom(0).text).toContain('STDIN_ONLY')
        expect(handle.collected.stdout!.readFrom(0).text).toContain('CONTROL_DONE')
        expect(await handle.waitForExit()).toBe(true)
      }
      for (const mode of ['unrestricted', 'read-only', 'workspace-write'] as const) {
        const argv = [process.execPath, '-e', `process.on('SIGINT',()=>console.log('INTERRUPTED')); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', b => { if(b.includes(3)) console.log('INTERRUPTED'); else console.log('INPUT:'+b.toString()) }); console.log('PID:'+process.pid+':'); console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.columns+'x'+process.stdout.rows); process.stdout.on('resize',()=>console.log('SIZE:'+process.stdout.columns+'x'+process.stdout.rows));`]
        const wrapped = mode !== 'unrestricted' ? (await ctx.sandbox.confine(argv, { mode, workspaceRoot: root })).argv : argv
        const terminal = await ctx.subprocess.spawnTerminal({ argv: wrapped, cwd: root, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 2000 })
        let output = ''
        terminal.output.on('data', chunk => { output += chunk.toString() })
        try {
          await expect.poll(() => output, { timeout: 10000 }).toContain('TTY:true:80x24')
          await terminal.write('ping')
          await expect.poll(() => output).toContain('INPUT:ping')
          await terminal.resize(100, 30)
          await expect.poll(() => output).toContain('SIZE:100x30')
          expect(terminal.pid).toBeGreaterThan(0)
          expect(output).toContain('PID:'+terminal.pid+':')
          expect(await terminal.inspectForeground()).toEqual({ processGroupId: terminal.pid, inputWaiting: false })
          expect(await terminal.signalForeground('SIGINT')).toBe(terminal.pid)
          await expect.poll(() => output, { timeout: 5000 }).toContain('INTERRUPTED')
          await terminal.write('after-interrupt')
          await expect.poll(() => output).toContain('INPUT:after-interrupt')
          expect(await terminal.signalForeground('SIGTERM')).toBe(terminal.pid)
          expect((await terminal.done).signal).toBe('SIGTERM')
        } finally { await terminal.terminate() }
        await terminal.done
      }
      const next = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'console.log("AFTER_PTY")'], cwd: root, graceMs: 2000,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
      expect((await next.done).exitCode).toBe(0)
      expect(next.collected.stdout!.readFrom(0).text).toContain('AFTER_PTY')
    } finally {
      await ctx.fiber.dispose()
      const child = relative(resolve(tmpdir()), resolve(root))
      expect(child && !child.startsWith('..') && !isAbsolute(child), 'safe test cleanup path').toBeTruthy()
      await rm(root, { recursive: true, force: true })
    }
  }, 90000)
})
