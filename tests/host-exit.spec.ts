import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { RunsealRpcClient } from '../src/rpc-client.ts'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'

const binary = process.env.RUNSEAL_TEST_BINARY

describe.skipIf(process.platform !== 'win32' || !binary)('native Windows host loss', () => {
  it.each(['exit', 'kill'])('reclaims two provider executions and descendants after host %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'runseal-provider-host-'))
    const fixture = join(root, 'provider-host.mjs')
    const cordis = pathToFileURL(createRequire(import.meta.url).resolve('@deepseek-ai/cordis')).href
    const plugin = pathToFileURL(resolve('lib/index.js')).href
    await writeFile(fixture, `
      import { Context } from ${JSON.stringify(cordis)};
      import * as Plugin from ${JSON.stringify(plugin)};
      const ctx = new Context();
      await ctx.plugin(Plugin, {command:process.argv[2],autoSetup:false,timeoutMs:30000});
      const root=process.argv[3], handles=[];
      for(let i=0;i<2;i++){
        const code='const{spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},1000)';
        const confined=await ctx.sandbox.confine([process.execPath,'-e',code],{mode:'workspace-write',workspaceRoot:root});
        handles.push(ctx.subprocess.spawn({argv:confined.argv,cwd:root,graceMs:2000,stdio:{stdin:'ignore',stdout:{maxBytes:4096},stderr:{maxBytes:4096}}}));
      }
      while(!handles.every(h=>h.collected.stdout.readFrom(0).text.includes('descendant')))await new Promise(r=>setTimeout(r,20));
      console.log(JSON.stringify(handles.map(h=>JSON.parse(h.collected.stdout.readFrom(0).text))));
      if(process.argv[4]==='exit')process.exit(97);
    `)
    const host = spawn(process.execPath, [fixture, resolve(binary!), root, mode], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', diagnostic = '', cleaned = false
    host.stdout.on('data', chunk => { output += chunk })
    host.stderr.on('data', chunk => { diagnostic += chunk })
    const exited = new Promise(resolve => host.once('exit', resolve))
    try {
      await expect.poll(() => output, { timeout: 20000, message: diagnostic }).toContain('\n')
      const children = JSON.parse(output.trim()) as { pid: number; descendant: number }[]
      if (mode === 'kill') host.kill('SIGKILL')
      await exited
      await expect.poll(async () => {
        const files = await readdir(join(root, '.runseal', 'audit'))
        const terminals = []
        for (const file of files.filter(file => file.endsWith('.jsonl'))) {
          const events = (await readFile(join(root, '.runseal', 'audit', file), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
          terminals.push(...events.filter(event => event.result?.cleanup_complete === true && event.result.termination_reason === 'client_disconnected'))
        }
        return terminals.length
      }, { timeout: 15000 }).toBe(2)
      for (const child of children) for (const pid of [child.pid, child.descendant]) {
        await expect.poll(() => { try { process.kill(pid, 0); return true } catch { return false } }, { timeout: 5000 }).toBe(false)
      }
      cleaned = true
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill()
      if (cleaned) await rm(root, { recursive: true, force: true })
    }
  }, 45000)

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
