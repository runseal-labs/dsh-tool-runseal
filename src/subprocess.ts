/** RPC-owned subprocesses: never place the RunSeal owner inside dsh's kill range. */
import { isAbsolute, resolve, join } from 'node:path'
import { resolveExecutable as resolveProgram } from './executable.cjs'
import { sandboxUnavailable } from './errors.ts'
import { Duplex, PassThrough, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, SubprocessExecutableNotFoundError, scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec, SubprocessOutputMode, SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector, prepareManagedProcessBinding } from '@deepseek-ai/dsh-subprocess-local/output'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { confinedSpec } from './confinement.ts'
import { confineSessionTerminal } from './terminal-policy.ts'
import { RpcError, RunsealRpcClient } from './rpc-client.ts'
import type { RpcErrorData } from './rpc-client.ts'
import type { ResolvedEngineConfig } from './engine.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

function environment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = scrubbedParentEnv()
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const existing = Object.keys(result).find(name => process.platform === 'win32' ? name.toLowerCase() === key.toLowerCase() : name === key)
    if (existing) delete result[existing]
    if (value !== undefined) result[key] = value
  }
  return result
}

function validate(spec: SubprocessSpawnSpec): void {
  spec.signal?.throwIfAborted()
  if (!spec.argv.length || spec.argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !spec.argv[0]) throw new Error('runseal: argv must contain a non-empty executable')
  if (!isAbsolute(spec.cwd) || spec.cwd.includes('\0')) throw new Error('runseal: cwd must be absolute')
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > 2147483647) throw new Error('runseal: invalid graceMs')
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (!key || (key.includes('=') || key.includes('\0')) || (value !== undefined && (typeof value !== 'string' || value.includes('\0')))) throw new Error('runseal: invalid environment entry')
  }
  for (const mode of [spec.stdio.stdout, spec.stdio.stderr]) {
    if (mode === 'pipe' || mode === 'inherit') continue
    if (!mode || !Number.isSafeInteger(mode.maxBytes) || mode.maxBytes < 1 || (mode.spill && (!Number.isSafeInteger(mode.spill.maxBytes) || mode.spill.maxBytes < 1))) throw new Error('runseal: invalid output limits')
  }
  const stdin = spec.stdio.stdin
  if (stdin !== 'pipe' && stdin !== 'ignore' && (!stdin || typeof stdin.data !== 'string')) throw new Error('runseal: invalid stdin')
  if (Object.keys(spec.env ?? {}).some(key => key.toUpperCase() === SUBPROCESS_CONTROL_ENV)) throw new Error('runseal: reserved control-channel environment entry')
}

function output(mode: SubprocessOutputMode, stream: 'stdout' | 'stderr') {
  const pipe = mode === 'pipe' ? new PassThrough() : undefined
  const binding = typeof mode === 'object' && mode.spill ? prepareManagedProcessBinding() : undefined
  const collector = typeof mode === 'object' ? new OutputCollector(mode.maxBytes, stream,
    mode.spill && binding ? { ...mode.spill, dir: binding.spillDir, onFailure: binding.onSpillFailure } : undefined) : undefined
  return {
    pipe, collector,
    write(bytes: Buffer) {
      if (collector) collector.push(bytes)
      else if (pipe) pipe.write(bytes)
      else process[stream].write(bytes)
    },
    end() { collector?.seal(); pipe?.end() },
  }
}

interface RpcConnection {
  client: RunsealRpcClient
  listeners: Set<(event: Record<string, unknown>) => void>
  retired: boolean
}

export class RunsealSubprocessRuntime extends SubprocessRuntime {
  private readonly live = new Set<SubprocessHandle>()
  private readonly connections = new Map<string, RpcConnection>()
  private readonly ownedConnections = new Set<RpcConnection>()
  private disposed = false

  constructor(ctx: Context, private readonly config: ResolvedEngineConfig | (() => ResolvedEngineConfig)) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposed = true
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      const results = await Promise.allSettled(handles.map(handle => handle.waitForExit()))
      const closed = await Promise.allSettled([...this.ownedConnections].map(connection => connection.client.close()))
      this.connections.clear()
      this.ownedConnections.clear()
      const failures = [...results, ...closed].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'runseal: cleanup could not be verified')
    }, 'runseal subprocess teardown')
  }

  async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    if (!command || command.includes('\0') || (!isAbsolute(command) && /[/\\]/.test(command))) throw new Error('runseal: use an absolute executable or a PATH name')
    return this.resolveChildExecutable(command, environment(env), process.cwd(), signal)
  }

  private async resolveChildExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal): Promise<string> {
    try { return await resolveProgram(command, env, cwd, signal) }
    catch (error) {
      signal?.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SubprocessExecutableNotFoundError(String(error))
      throw error
    }
  }
  async terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    const shell = process.platform === 'win32' ? process.env.ComSpec : process.env.SHELL
    return { platform: process.platform === 'win32' ? 'windows' : 'posix', ...shell ? { defaultShell: shell } : {} }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    spec.signal?.throwIfAborted()
    spec = await confineSessionTerminal(this.ctx, spec)
    const dimensions = (cols: number, rows: number) => {
      if (![cols, rows].every(value => Number.isInteger(value) && value >= 1 && value <= 1000)) throw new Error('runseal: terminal dimensions must be from 1 to 1000')
    }
    dimensions(spec.cols, spec.rows)
    const execution = this.spawnExecution({ ...spec, env: { ...spec.env, TERM: spec.terminalType },
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }, spec)
    let pid: number
    try { pid = await execution.started } catch (error) {
      execution.handle.terminate()
      await execution.handle.waitForExit()
      spec.signal?.throwIfAborted()
      throw error
    }
    spec.signal?.removeEventListener('abort', execution.handle.terminate)
    if (spec.signal?.aborted) { execution.handle.terminate(); await execution.handle.waitForExit(); spec.signal.throwIfAborted() }
    let revision = 0
    const handle = execution.handle
    return {
      pid, output: handle.stdout!, done: handle.done,
      write: async data => { revision++; await execution.write('stdin', Buffer.from(data)) },
      resize: async (cols, rows) => { dimensions(cols, rows); await execution.request('resizeExecution', { cols, rows }) },
      // POSIX jobs can leave the root group; without a native observation it is unknown.
      inspectForeground: async () => process.platform === 'win32' && execution.isRunning() ? { processGroupId: pid, inputWaiting: false } : undefined,
      inspectActivity: async () => ({ state: 'unknown', revision }),
      signalForeground: async signal => {
        if (!execution.isRunning()) throw new Error('runseal: terminal is closing')
        if (signal === 'SIGKILL') throw new Error('runseal: refusing to SIGKILL the terminal shell; terminate the session instead')
        if (signal === 'SIGTERM') {
          handle.terminate()
          await handle.waitForExit()
          await execution.join()
          revision++
          return pid
        }
        if (signal !== 'SIGINT') throw new Error(`runseal: unsupported foreground signal ${signal}`)
        const target = await execution.interrupt()
        if (process.platform === 'win32' && target !== pid) throw new Error('runseal: interrupt target differs from terminal identity')
        revision++
        return target
      },
      terminate: async () => { handle.terminate(); await handle.waitForExit(); await execution.join() },
    }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.spawnExecution(spec).handle
  }

  private spawnExecution(spec: SubprocessSpawnSpec, pty?: SubprocessTerminalSpawnSpec) {
    if (this.disposed) throw new Error('runseal: subprocess provider disposed')
    validate(spec)
    const confinement = confinedSpec(spec.argv)
    let config: ResolvedEngineConfig
    try { config = typeof this.config === 'function' ? this.config() : this.config }
    catch (error) {
      if (confinement && confinement.policy !== 'danger-full-access') throw sandboxUnavailable(confinement.policy, error)
      throw error
    }
    const stdout = output(spec.stdio.stdout, 'stdout')
    const stderr = output(spec.stdio.stderr, 'stderr')
    const done = deferred<SubprocessOutcome>()
    const quiescent = deferred<void>()
    const admitted = deferred<string>()
    const started = deferred<number>()
    const deliveries = new Map<number, ReturnType<typeof deferred<number>>>()
    const delivery = (sequence: number) => {
      let value = deliveries.get(sequence)
      if (!value) { value = deferred<number>(); deliveries.set(sequence, value) }
      return value
    }
    const operations = new Set<Promise<unknown>>()
    let executionId: string | undefined
    let cancelled = false
    let cancelSent = false
    let terminal = false
    let submitted = false
    let settled = false
    let ioFailure: unknown
    const childEnv: NodeJS.ProcessEnv = { ...spec.env, ...spec.stdio.control ? { [SUBPROCESS_CONTROL_ENV]: 'pipe' } : {} }
    const env = environment(childEnv)
    // The RPC owner uses host setup state even when a consumer clears LOCALAPPDATA.
    // Keep the child's requested environment removal; do not restore its user profile.
    if (process.platform === 'win32') {
      const home = process.env.RUNSEAL_WINDOWS_SANDBOX_HOME
        ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'RunSeal', 'windows-sandbox') : undefined)
      if (home) env.RUNSEAL_WINDOWS_SANDBOX_HOME = resolve(home)
    }
    const transport = { command: config.command, args: config.args, env, replaceEnv: true }
    let client: RunsealRpcClient
    let connection: RpcConnection | undefined
    const onEvent = (event: Record<string, unknown>) => {
      if (event.execution_id !== executionId) return
      if (event.type === 'execution.started') {
        if (!Number.isSafeInteger(event.process_id) || (event.process_id as number) <= 0) {
          started.reject(new Error('runseal: missing native process identity')); terminate()
        } else started.resolve(event.process_id as number)
      }
      if (event.type === 'execution.signal_delivered' && Number.isSafeInteger(event.sequence) && (event.sequence as number) > 0) {
        const target = process.platform === 'win32' ? event.target_process_id : event.target_process_group_id
        if (Number.isSafeInteger(target) && (target as number) > 0) delivery(event.sequence as number).resolve(target as number)
      }
      if (event.type === 'execution.control' && typeof event.data === 'string' && event.data.startsWith('base64:')) control?.push(Buffer.from(event.data.slice(7), 'base64'))
      if (event.type === 'execution.stdout' || event.type === 'execution.stderr' || event.type === 'execution.terminal') {
        if (typeof event.data !== 'string' || !event.data.startsWith('base64:')) return
        const sink = event.type === 'execution.stderr' ? stderr : stdout
        sink.write(Buffer.from(event.data.slice(7), 'base64'))
      }
    }
    const cancel = () => {
      if (terminal || cancelSent || !executionId) return
      cancelSent = true
      // A cancel receipt is not cleanup proof. Only the terminal settles the handle.
      void client.request('cancelExecution', { execution_id: executionId }).catch(error => {
        if (!terminal && !(error instanceof RpcError && error.code === 'EXECUTION_NOT_CANCELLABLE')) ioFailure ??= error
      })
    }
    const terminate = () => { if (!terminal) { cancelled = true; cancel() } }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    for (const pipe of [stdout.pipe, stderr.pipe]) pipe?.on('error', error => { if (!terminal) { ioFailure = error; terminate() } })
    const request = (method: string, params: Record<string, unknown>) => {
      const promise = (async () => {
        const id = await admitted.promise
        if (terminal || cancelled) throw new Error('runseal: execution is closing')
        return client.request(method, { execution_id: id, ...params })
      })()
      operations.add(promise)
      void promise.then(() => operations.delete(promise), () => operations.delete(promise))
      return promise
    }
    const inputQueues = { stdin: Promise.resolve(), control: Promise.resolve() }
    const write = (stream: 'stdin' | 'control', chunk: Buffer) => {
      const pending = inputQueues[stream].then(async () => {
        if (terminal || cancelled) throw new Error('runseal: execution is closing')
        for (let offset = 0; offset < chunk.length; offset += 8192) {
          const bytes = chunk.subarray(offset, offset + 8192)
          for (;;) {
            try {
              const receipt = await request('writeExecutionInput', { stream, encoding: 'base64', data: `base64:${bytes.toString('base64')}` }) as Record<string, unknown>
              if (receipt.accepted_bytes !== bytes.length) throw new Error('runseal: input receipt did not accept the complete chunk')
              break
            } catch (error) {
              // RFC-0021: backpressure means zero bytes were accepted. Retain
              // this chunk and yield to I/O; never replay an accepted chunk.
              if (!(error instanceof RpcError) || error.code !== 'INPUT_BACKPRESSURE') throw error
              await new Promise<void>(resolve => setImmediate(resolve))
            }
          }
        }
      })
      inputQueues[stream] = pending
      operations.add(pending)
      void pending.then(() => operations.delete(pending), () => operations.delete(pending))
      return pending
    }
    const input = new Writable({
      write(chunk: Buffer, _encoding, callback) { void write('stdin', chunk).then(() => callback(), callback) },
      final(callback) { void request('closeExecutionInput', { stream: 'stdin' }).then(() => callback(), callback) },
    })
    const control = spec.stdio.control ? new Duplex({
      allowHalfOpen: true,
      read() {},
      write(chunk: Buffer, _encoding, callback) { void write('control', chunk).then(() => callback(), callback) },
      final(callback) { void request('closeExecutionInput', { stream: 'control' }).then(() => callback(), callback) },
    }) : undefined
    control?.on('error', error => { if (!terminal && !cancelled) { ioFailure = error; terminate() } })
    input.on('error', error => { if (!terminal && !cancelled) { ioFailure = error; terminate() } })
    const finish = async (result?: Record<string, unknown>, error?: unknown) => {
      const originalError = error
      if (error && confinement && confinement.policy !== 'danger-full-access'
          && !spec.signal?.aborted && !(error instanceof SubprocessExecutableNotFoundError)
          && (!(error instanceof RpcError) || ['BACKEND_UNAVAILABLE', 'POLICY_DENIED', 'INVALID_REQUEST', 'UNSUPPORTED_FEATURE', 'EXECUTION_FAILED_TO_START'].includes(error.code))) {
        error = sandboxUnavailable(confinement.policy, error)
      }
      terminal = true
      spec.signal?.removeEventListener('abort', terminate)
      admitted.reject(error ?? new Error('runseal: execution ended'))
      started.reject(error ?? new Error('runseal: execution ended before terminal startup'))
      for (const value of deliveries.values()) value.reject(error ?? new Error('runseal: execution ended before signal delivery'))
      input.destroy()
      control?.push(null)
      stdout.end(); stderr.end()
      // Rejected admission proves no new execution started; transport loss does not.
      const clean = result ? result.cleanup_complete === true
        : originalError instanceof RpcError && originalError.code !== 'EXECUTION_CLEANUP_FAILED' && originalError.data.cleanup_complete !== false
      const noLaunch = !submitted
      connection?.listeners.delete(onEvent)
      if (connection && submitted && !clean) connection.retired = true
      if (connection?.retired && connection.listeners.size === 0) {
        await connection.client.close()
        this.ownedConnections.delete(connection)
      }
      settled = true
      if (clean || noLaunch) quiescent.resolve()
      else quiescent.reject(error ?? new Error('runseal: terminal did not confirm cleanup_complete'))
      if (error) done.reject(error)
      else if (!clean && !noLaunch) done.reject(new Error('runseal: terminal did not confirm cleanup_complete'))
      else if (ioFailure) done.reject(ioFailure)
      else if (result?.error && !(cancelled && (result.error as RpcErrorData).code === 'EXECUTION_CANCELLED')) {
        const data = result.error as RpcErrorData
        const failure = new RpcError(data.reason ?? data.code, data)
        done.reject(confinement && confinement.policy !== 'danger-full-access' && ['BACKEND_UNAVAILABLE', 'POLICY_DENIED', 'EXECUTION_FAILED_TO_START'].includes(data.code)
          ? sandboxUnavailable(confinement.policy, failure) : failure)
      } else done.resolve({ exitCode: typeof result?.exit_code === 'number' ? result.exit_code : null,
        signal: cancelled ? 'SIGTERM' : typeof result?.signal === 'string' ? result.signal as NodeJS.Signals : null })
    }
    const handle: SubprocessHandle = {
      stdin: spec.stdio.stdin === 'pipe' ? input : undefined, stdout: stdout.pipe, stderr: stderr.pipe, control,
      collected: { ...stdout.collector ? { stdout: stdout.collector } : {}, ...stderr.collector ? { stderr: stderr.collector } : {} },
      done: done.promise, terminate,
      waitForExit: async signal => {
        if (settled) return quiescent.promise.then(() => true)
        if (signal?.aborted) return false
        return new Promise<boolean>((yes, no) => {
          const abort = () => { signal?.removeEventListener('abort', abort); yes(false) }
          signal?.addEventListener('abort', abort, { once: true })
          void quiescent.promise.then(() => { signal?.removeEventListener('abort', abort); yes(true) }, error => { signal?.removeEventListener('abort', abort); no(error) })
        })
      },
    }
    this.live.add(handle)
    void quiescent.promise.then(() => this.live.delete(handle), () => {})
    void (async () => {
      try {
        // Prove runner availability before treating execute as submitted.
        transport.command = await resolveProgram(config.command, env, process.cwd(), spec.signal)
        if (this.disposed) throw new Error('runseal: subprocess provider disposed')
        const key = JSON.stringify([transport.command, transport.args,
          Object.entries(env).sort(([a], [b]) => a.localeCompare(b))])
        connection = this.connections.get(key)
        if (!connection || connection.retired || !connection.client.usable) {
          const listeners = new Set<(event: Record<string, unknown>) => void>()
          connection = { client: new RunsealRpcClient(transport, event => {
            for (const listener of listeners) listener(event)
          }), listeners, retired: false }
          this.connections.set(key, connection)
          this.ownedConnections.add(connection)
        }
        client = connection.client
        connection.listeners.add(onEvent)
        let policy: unknown = confinement?.policy ?? 'danger-full-access'
        const network = confinement?.network ?? config.networkMode
        if (confinement?.policy === 'workspace-write') {
          const explained = await client.request('explainPolicy', { policy, cwd: confinement.cwd, network }) as Record<string, unknown>
          const filesystem = { ...explained.filesystem as Record<string, unknown> }
          delete filesystem.unrestricted
          policy = { id: explained.policy_id, sandbox_level: explained.sandbox_level, filesystem }
        }
        if (cancelled) { await finish(); return }
        const argv = confinement?.argv ?? spec.argv
        const program = await this.resolveChildExecutable(argv[0]!, env, spec.cwd, spec.signal)
        // PTC intentionally inherits this startup selector; RunSeal's minimal
        // child environment must not turn an Electron Node worker into a GUI.
        if (spec.stdio.control && process.env.ELECTRON_RUN_AS_NODE === '1'
            && !Object.keys(childEnv).some(key => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE')) {
          const host = await resolveProgram(process.execPath, env, spec.cwd, spec.signal)
          if (process.platform === 'win32' ? program.toLowerCase() === host.toLowerCase() : program === host) childEnv.ELECTRON_RUN_AS_NODE = '1'
        }
        if (cancelled) { await finish(); return }
        submitted = true
        const result = await client.execute({ command: [program, ...argv.slice(1)], cwd: spec.cwd, policy, network,
          stdin: { mode: 'stream' },
          ...pty ? { io: { mode: 'pty', rows: pty.rows, cols: pty.cols } } : spec.stdio.control ? { io: { mode: 'pipe', control: { mode: 'pipe', child_fd: SUBPROCESS_CONTROL_FD } } } : {},
          ...confinement ? { timeout_ms: confinement.timeoutMs } : {},
          env: Object.fromEntries(Object.entries(childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        }, id => { executionId = id; admitted.resolve(id); if (cancelled) cancel() }) as Record<string, unknown>
        await finish(result)
      } catch (error) { await finish(undefined, error) }
    })()
    if (spec.stdio.stdin !== 'pipe') input.end(spec.stdio.stdin === 'ignore' ? undefined : spec.stdio.stdin.data)
    const interrupt = () => {
      const pending = (async () => {
        const receipt = await request('signalExecution', { signal: 'interrupt' }) as Record<string, unknown>
        if (!Number.isSafeInteger(receipt.sequence) || (receipt.sequence as number) <= 0) throw new Error('runseal: invalid signal receipt')
        const sequence = receipt.sequence as number
        const confirmation = deliveries.get(sequence)
        if (terminal && !confirmation) throw new Error('runseal: execution ended before signal delivery')
        try { return await (confirmation ?? delivery(sequence)).promise }
        finally { deliveries.delete(sequence) }
      })()
      operations.add(pending)
      void pending.then(() => operations.delete(pending), () => operations.delete(pending))
      return pending
    }
    return { handle, started: started.promise, request, write, interrupt, isRunning: () => !terminal && !cancelled, join: async () => { await Promise.allSettled(operations) } }
  }
}
