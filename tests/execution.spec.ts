import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as Plugin from '../src/index.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { Context } from '@deepseek-ai/cordis'
import { RunsealSandboxProvider, RunsealEngine, resolveEngineConfig } from '../src/index.ts'
import { RunsealRpcClient } from '../src/rpc-client.ts'

const fake = fileURLToPath(new URL('./fake-runseal.cjs', import.meta.url))
function config(scenario: string) {
  return resolveEngineConfig({ command: process.execPath, args: [fake, scenario] })
}
async function runWrapper(scenario: string, input = '') {
  const provider = new RunsealSandboxProvider(new Context(), () => ({ ...config(scenario), timeoutMs: 1000, autoSetup: false }))
  const confined = await provider.confine(['unused'], { mode: 'read-only', workspaceRoot: process.cwd() })
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(confined.argv[0]!, confined.argv.slice(1), { stdio: 'pipe' })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('wrapper timed out')) }, 5000)
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(input)
  })
}

describe('wrapper process', () => {
  it('uses configured command/args, waits beyond receipt and streams output without duplicates', async () => {
    expect(await runWrapper('output')).toEqual({ code: 7, stdout: '你好', stderr: 'diagnostic' })
  })
  it('forwards stdin bytes and closes command input without closing RPC', async () => {
    const input = '你好\n'.repeat(9000)
    expect(await runWrapper('echo', input)).toEqual({ code: 0, stdout: input, stderr: '' })
  })
  it('reports admission failure with its stable code', async () => {
    expect(await runWrapper('reject')).toMatchObject({ code: 2, stderr: expect.stringContaining('BACKEND_UNAVAILABLE') })
  })
  it('does not report early clean connection closure as successful execution', async () => {
    expect(await runWrapper('abrupt')).toMatchObject({ code: 2, stderr: expect.stringContaining('RPC_CLOSED') })
  })
  it('reports terminal execution failure', async () => {
    expect(await runWrapper('failed')).toMatchObject({ code: 2, stderr: expect.stringContaining('EXECUTION_TIMEOUT') })
  })
})

describe('async sandbox and RPC execution', () => {
  it('rejects an already cancelled confine call', async () => {
    const provider = new RunsealSandboxProvider(new Context(), () => ({ ...config('output'), timeoutMs: 1000, autoSetup: false }))
    await expect(provider.confine(['unused'], { mode: 'read-only', workspaceRoot: process.cwd() }, AbortSignal.abort())).rejects.toThrow()
  })
  it('engine awaits terminal completion and assembles streamed output', async () => {
    const engine = new RunsealEngine(config('stream-only'), undefined)
    expect(await engine.execute(['unused'], process.cwd(), 'read-only')).toMatchObject({ exitCode: 7, stdout: '你好', stderr: 'diagnostic', executionId: 'exec_fixture' })
  })
  it('engine rejects terminal failures', async () => {
    const engine = new RunsealEngine(config('failed'), undefined)
    await expect(engine.execute(['unused'], process.cwd(), 'read-only')).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' })
  })
  it('cancels using the same RPC connection that owns the execution', async () => {
    const client = new RunsealRpcClient(config('cancel'), () => {})
    try {
      const result = await client.execute({}, id => { void client.request('cancelExecution', { execution_id: id }) })
      expect(result).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_CANCELLED' } })
    } finally { client.destroy() }
  })
  it('rejects an already aborted client without spawning', async () => {
    const client = new RunsealRpcClient({ ...config('cancel'), signal: AbortSignal.abort() }, () => {})
    await expect(client.execute({})).rejects.toThrow()
    client.destroy()
  })
})


describe('dsh service integration', () => {
  it('mounts in Cordis without an existing sandbox provider', async () => {
    const ctx = new Context()
    await ctx.plugin(Plugin, { command: process.execPath, args: [fake, 'output'], autoSetup: false })
    try {
      expect(ctx.sandbox).toBeInstanceOf(RunsealSandboxProvider)
    } finally { await ctx.fiber.dispose() }
  })
  it('executes the wrapper through the current dsh subprocess service', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const runtime = ctx.subprocess
    const provider = new RunsealSandboxProvider(ctx, () => ({ ...config('echo'), timeoutMs: 1000, autoSetup: false }))
    try {
      const confined = await provider.confine(['unused'], { mode: 'read-only', workspaceRoot: process.cwd() })
      const handle = runtime.spawn({ argv: confined.argv, cwd: process.cwd(), graceMs: 1000,
        stdio: { stdin: { data: 'dsh-input' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } } })
      expect(await handle.done).toMatchObject({ exitCode: 0 })
      expect(handle.collected.stdout?.readFrom(0).text).toBe('dsh-input')
      expect(handle.collected.stderr?.readFrom(0).text).toBe('')
    } finally { await ctx.fiber.dispose() }
  })
})
