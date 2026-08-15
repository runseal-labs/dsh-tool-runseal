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
  env?: Record<string, string>
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
    this.signal?.addEventListener('abort', () => {
      this.destroy()
    }, { once: true })
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the method name (e.g. `execute`).
   * @param params - the parameters object.
   * @returns the result value.
   */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const child = this.ensureChild()
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    if (child.stdin === null) {
      this.pending.delete(id)
      throw new Error('runseal rpc child stdin unavailable')
    }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return response
  }

  /** Kill the child and reject every in-flight request. */
  destroy(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('runseal rpc client destroyed'))
    }
    this.pending.clear()
    this.child?.kill()
    this.child = undefined
  }

  private ensureChild(): ChildProcess {
    if (this.child !== undefined && this.child.exitCode === null) return this.child
    this.child = spawn(this.options.command, [...(this.options.args ?? []), 'rpc', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...this.options.env !== undefined && Object.keys(this.options.env).length > 0
        ? { env: { ...process.env, ...this.options.env } }
        : {},
    })
    const stdout = this.child.stdout as Readable
    stdout.on('data', (chunk: Buffer<ArrayBuffer>) => this.onData(chunk))
    this.child.stderr?.on('data', (_chunk) => {
      // runseal writes diagnostics to stderr; keep the stream drained so the
      // child never blocks on a full stderr pipe.
    })
    this.child.on('error', (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
    })
    this.child.on('exit', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('runseal rpc child exited'))
      }
      this.pending.clear()
    })
    return this.child
  }

  private onData(chunk: Buffer<ArrayBuffer>): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let newline: number
    while ((newline = this.buffer.indexOf(0x0a)) >= 0) {
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.length === 0) continue
      if (line.length > this.maxLineBytes) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line.toString('utf8')) as Record<string, unknown>
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message.method === 'event' && typeof message.params === 'object' && message.params !== null) {
      this.onEvent(message.params as Record<string, unknown>)
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
    pending.resolve(message.result)
  }
}