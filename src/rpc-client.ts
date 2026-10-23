/**
 * Minimal JSON-RPC 2.0 client over `runseal rpc --stdio`. One persistent child
 * process, newline-delimited JSON-RPC messages. Each request resolves with the
 * matching `result` or rejects with the structured `error`; `method: "event"`
 * notifications are dispatched to a listener. Reconnects lazily on demand when
 * the child died.
 * @module dsh-tool-runseal/rpc-client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'

/** One in-flight request awaiting its response. */
interface PendingRequest {
  execution?: boolean
  onAccepted?: (executionId: string) => void
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/** A JSON-RPC error payload as emitted by runseal. */
export interface RpcErrorData {
  /** Stable runseal error code, e.g. `INVALID_REQUEST`, `BACKEND_UNAVAILABLE`. */
  code: string
  /** Human-readable reason. */
  reason: string
  [key: string]: unknown
}

/** A structured JSON-RPC error, carrying runseal's stable code. */
export class RpcError extends Error {
  /** Stable runseal error code. */
  readonly code: string
  /** The full error data object. */
  readonly data: RpcErrorData

  constructor(message: string, data: RpcErrorData) {
    super(message)
    this.name = 'RpcError'
    this.code = data.code
    this.data = data
  }
}

/** Options for {@link RunsealRpcClient}. */
export interface RpcClientOptions {
  /** The runseal executable: absolute path or PATH-resolved name. */
  command: string
  /** Extra arguments before the `rpc` subcommand. Default `[]`. */
  args?: readonly string[]
  /** Abort signal that kills the child and rejects in-flight requests. */
  signal?: AbortSignal
  /** Maximum buffered stdout line length before truncation. Default 16 MiB. */
  maxLineBytes?: number
  /** Extra environment entries for the child. Default `{}`. */
  env?: NodeJS.ProcessEnv
  /** Use env as the complete transport environment instead of inheriting the host. */
  replaceEnv?: boolean
}

/**
 * Persistent JSON-RPC client over `runseal rpc --stdio`. Lazily spawns the
 * child on the first request, keeps it for the lifetime, and re-spawns when it
 * died. Frames are newline-delimited JSON; server-initiated `event`
 * notifications are forwarded to `onEvent`.
 */
export class RunsealRpcClient {
  private child: ChildProcess | undefined
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private readonly executions = new Map<string, PendingRequest>()
  private readonly abort = () => this.destroy()
  private destroyed = false
  private closed: Promise<void> = Promise.resolve()
  private nextId = 1
  private readonly maxLineBytes: number
  private readonly signal: AbortSignal | undefined

  constructor(
    private readonly options: RpcClientOptions,
    /** Server-initiated event notifications, e.g. `execution.stdout`. */
    readonly onEvent: (event: Record<string, unknown>) => void,
  ) {
    this.maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024
    this.signal = options.signal
    this.signal?.addEventListener('abort', this.abort, { once: true })
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the method name (e.g. `execute`).
   * @param params - the parameters object.
   * @returns the result value.
   */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send(method, params)
  }

  /** Await the terminal event, rather than treating an admission receipt as completion. */
  async execute(params: Record<string, unknown>, onAccepted?: (executionId: string) => void): Promise<unknown> {
    return this.send('execute', params, true, onAccepted)
  }

  private async send(method: string, params: Record<string, unknown>, execution = false, onAccepted?: (executionId: string) => void): Promise<unknown> {
    if (this.destroyed) throw new Error('runseal rpc client destroyed')
    this.signal?.throwIfAborted()
    const id = this.nextId++
    const child = this.ensureChild()
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, execution, ...onAccepted ? { onAccepted } : {} })
    })
    if (child.stdin === null) {
      this.pending.delete(id)
      throw new Error('runseal rpc child stdin unavailable')
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return response
  }

  /** Close the connection and reject every in-flight request; RunSeal owns cleanup. */
  destroy(): void {
    this.destroyed = true
    this.signal?.removeEventListener('abort', this.abort)
    this.rejectAll(new Error('runseal rpc client destroyed'))
    // EOF cancels owned executions and allows native cleanup before process exit.
    this.child?.stdin?.end()
    this.child = undefined
    this.buffer = Buffer.alloc(0)
  }

  /** End RPC input, then wait for the owner process to finish native cleanup and exit. */
  async close(): Promise<void> {
    this.destroy()
    await this.closed
  }

  private ensureChild(): ChildProcess {
    if (this.child !== undefined && this.child.exitCode === null) return this.child
    this.child = spawn(this.options.command, [...(this.options.args ?? []), 'rpc', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // On Windows, keep the cleanup owner out of the host console's lifetime.
      // Pipes remain owned: host death delivers EOF and RunSeal joins cleanup.
      detached: process.platform === 'win32',
      windowsHide: true,
      ...this.options.env !== undefined
        ? { env: this.options.replaceEnv ? this.options.env : { ...process.env, ...this.options.env } }
        : {},
    })
    const child = this.child
    this.closed = new Promise(resolve => child.once('close', () => resolve()))
    const stdout = child.stdout as Readable
    stdout.on('data', (chunk: Buffer<ArrayBuffer>) => { if (this.child === child) this.onData(chunk) })
    this.child.stderr?.on('data', (_chunk) => {
      // runseal writes diagnostics to stderr; keep the stream drained so the
      // child never blocks on a full stderr pipe.
    })
    child.stdin?.on('error', error => { if (this.child === child) this.rejectAll(error) })
    child.on('error', error => { if (this.child === child) this.rejectAll(error) })
    child.on('close', () => {
      if (this.child !== child) return
      this.rejectAll(new Error('runseal rpc child exited'))
      this.child = undefined
      this.buffer = Buffer.alloc(0)
    })
    return this.child
  }

  private rejectAll(error: Error): void {
    for (const request of [...this.pending.values(), ...this.executions.values()]) request.reject(error)
    this.pending.clear()
    this.executions.clear()
  }

  private onData(chunk: Buffer<ArrayBuffer>): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let newline: number
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > this.maxLineBytes) return this.protocolError('RPC frame exceeds limit')
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line.toString('utf8')) as Record<string, unknown>
      } catch {
        return this.protocolError('invalid JSON-RPC frame')
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) return this.protocolError('invalid JSON-RPC message')
      this.dispatch(message)
    }
    if (this.buffer.length > this.maxLineBytes) this.protocolError('RPC frame exceeds limit')
  }

  private protocolError(reason: string): void {
    this.rejectAll(new Error(reason))
    this.destroy()
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message.method === 'event' && typeof message.params === 'object' && message.params !== null) {
      const event = message.params as Record<string, unknown>
      this.onEvent(event)
      const executionId = typeof event.execution_id === 'string' ? event.execution_id : ''
      const execution = this.executions.get(executionId)
      if (execution && (event.type === 'execution.finished' || event.type === 'execution.failed')) {
        this.executions.delete(executionId)
        if (typeof event.result !== 'object' || event.result === null) execution.reject(new Error('terminal event has no result'))
        else execution.resolve(event.result)
      }
      return
    }
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    if (message.error !== undefined) {
      const data = (message.error as { data?: RpcErrorData }).data
      const code = data?.code ?? 'RPC_ERROR'
      pending.reject(new RpcError(
        (message.error as { message?: string }).message ?? `runseal rpc error ${code}`,
        data ?? { code, reason: 'no details' },
      ))
      return
    }
    const result = message.result as Record<string, unknown> | undefined
    if (pending.execution && result && (result.status === 'preparing' || result.status === 'running') && typeof result.execution_id === 'string') {
      this.executions.set(result.execution_id, pending)
      pending.onAccepted?.(result.execution_id)
      return
    }
    pending.resolve(message.result)
  }
}
