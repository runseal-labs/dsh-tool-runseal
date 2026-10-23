import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { RunsealRpcClient } from '../src/rpc-client.ts'

const binary = process.env.RUNSEAL_TEST_BINARY

describe.skipIf(process.platform !== 'win32' || !binary)('native Windows host loss', () => {
  it.each(['exit', 'kill'])('cleans up after host %s and admits another execution without repair', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'runseal-host-loss-'))
    const clientModule = join(root, 'client.mjs')
    await build({ entryPoints: [resolve('src/rpc-client.ts')], outfile: clientModule, platform: 'node', format: 'esm', bundle: true })
    const fixture = join(root, 'host.mjs')
    await writeFile(fixture, `
      import { RunsealRpcClient } from './client.mjs';
      const client = new RunsealRpcClient({ command: process.argv[2] }, event => {
        if (event.type === 'execution.started') {
          process.stdout.write(JSON.stringify({ audit: event.audit_path }) + '\\n', () => {
            if (process.argv[4] === 'exit') process.exit(97);
          });
        }
      });
      await client.execute({ command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
        cwd: process.argv[3], policy: 'workspace-write', network: 'unmanaged',
        stdin: { mode: 'stream' }, io: { mode: 'pty', rows: 24, cols: 80 }, timeout_ms: 30000 });
    `)
    const host = spawn(process.execPath, [fixture, resolve(binary!), root, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', diagnostic = ''
    host.stdout.on('data', chunk => { output += chunk })
    host.stderr.on('data', chunk => { diagnostic += chunk })
    const exited = new Promise<number | null>((done, reject) => { host.once('error', reject); host.once('exit', done) })
    let cleaned = false
    try {
      await expect.poll(() => output, { timeout: 15000, message: 'host must start a real restricted execution' }).toContain('\n')
      const { audit } = JSON.parse(output.trim()) as { audit: string }
      if (mode === 'kill') host.kill('SIGKILL')
      await exited
      const auditPath = resolve(root, audit)
      await expect.poll(async () => {
        const events = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        const terminal = events.find(event => event.result?.cleanup_complete === true)
        if (!terminal) return undefined
        expect(terminal.result.sandbox).toEqual({ enforced: true, level: 'workspace-write' })
        expect(terminal.result.termination_reason).toBe('client_disconnected')
        return terminal.result.cleanup_complete
      }, { timeout: 15000, message: diagnostic }).toBe(true)
      cleaned = true
      const retry = new RunsealRpcClient({ command: resolve(binary!) }, () => {})
      try {
        const result = await retry.execute({ command: [process.execPath, '-e', 'console.log("HOST_LOSS_RETRY_OK")'],
          cwd: root, policy: 'workspace-write', network: 'unmanaged' }) as Record<string, unknown>
        expect(result.exit_code).toBe(0)
        expect(result.cleanup_complete).toBe(true)
      } finally { await retry.close() }
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill()
      // Preserve failed cleanup evidence; never repair a gate or remove live roots in a test.
      if (cleaned) await rm(root, { recursive: true, force: true })
    }
  }, 45000)
})
