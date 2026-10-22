/** One wrapper process owns one RunSeal RPC connection and execution. */
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')

const spec = JSON.parse(process.argv[2])
let child
let executionId
let done = false
let setupAttempted = false
let receivedOutput = { stdout: false, stderr: false }
let nextId = 2
const pending = new Map()

function send(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

function finish(code) {
  if (done) return
  done = true
  process.exitCode = code
  process.stdin.destroy()
  for (const request of pending.values()) request.reject(new Error('execution ended'))
  pending.clear()
  // EOF after terminal completion lets RunSeal perform its own cleanup.
  child?.stdin.end()
}

function fail(error, executionFailure = false) {
  if (done) return
  process.stderr.write(`runseal${executionFailure ? " execution" : ""}: ${error.code ?? 'RPC_ERROR'}: ${error.reason ?? error.message ?? String(error)}\n`)
  finish(2)
}

async function forwardInput() {
  try {
    for await (const chunk of process.stdin) {
      if (done) return
      const bytes = Buffer.from(chunk)
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        if (done) return
        await send('writeExecutionInput', {
          execution_id: executionId, stream: 'stdin', encoding: 'base64',
          data: `base64:${bytes.subarray(offset, offset + 8192).toString('base64')}`,
        })
      }
    }
    if (!done) await send('closeExecutionInput', { execution_id: executionId, stream: 'stdin' })
  } catch (error) {
    if (!done) fail(error)
  }
}

function complete(result) {
  for (const stream of ['stdout', 'stderr']) {
    if (!receivedOutput[stream] && typeof result[stream] === 'string') process[stream].write(result[stream])
  }
  if (result.status === 'failed' || result.error) {
    fail(result.error ?? { code: 'EXECUTION_FAILED', reason: 'execution failed' }, true)
  } else {
    finish(Number.isInteger(result.exit_code) ? result.exit_code : 1)
  }
}

function handleError(error) {
  const setup = error.setup_status
  if (spec.autoSetup && !setupAttempted && process.platform === 'win32'
      && setup?.requires_setup === true && !executionId) {
    setupAttempted = true
    const oldChild = child
    oldChild.stdin.end()
    const setupChild = spawn(spec.command, [...(spec.args ?? []), 'setup', 'windows-sandbox', '--cwd', spec.cwd, '--elevate'], { stdio: 'ignore' })
    setupChild.on('error', fail)
    setupChild.on('close', code => {
      if (done) return
      if (code !== 0) return fail({ code: 'SETUP_FAILED', reason: `setup exited with ${code}` })
      start()
    })
    return
  }
  fail(error)
}

function start() {
  if (done) return
  executionId = undefined
  receivedOutput = { stdout: false, stderr: false }
  const rpc = child = spawn(spec.command, [...(spec.args ?? []), 'rpc', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let retrying = false
  rpc.stdout.on('data', chunk => {
    if (done || rpc !== child || retrying) return
    buffer += decoder.write(chunk)
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) return fail({ code: 'PROTOCOL_ERROR', reason: 'RPC frame exceeds limit' })
      let message
      try { message = JSON.parse(line) } catch { return fail({ code: 'PROTOCOL_ERROR', reason: 'invalid JSON-RPC frame' }) }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail({ code: 'PROTOCOL_ERROR', reason: 'invalid JSON-RPC message' })
      if (message.method === 'event') {
        const event = message.params
        if (!event || (executionId && event.execution_id !== executionId)) continue
        if (event.type === 'execution.stdout' || event.type === 'execution.stderr') {
          const stream = event.type === 'execution.stdout' ? 'stdout' : 'stderr'
          if (typeof event.data === 'string') {
            receivedOutput[stream] = true
            process[stream].write(event.data.startsWith('base64:') ? Buffer.from(event.data.slice(7), 'base64') : event.data)
          }
        } else if (executionId && (event.type === 'execution.finished' || event.type === 'execution.failed')) {
          if (!event.result || typeof event.result !== 'object') return fail({ code: 'PROTOCOL_ERROR', reason: 'terminal event has no result' })
          complete(event.result)
        }
      } else if (message.id === 1) {
        if (message.error) {
          const error = message.error.data ?? message.error
          retrying = spec.autoSetup && !setupAttempted && process.platform === 'win32' && error.setup_status?.requires_setup === true
          handleError(error)
        } else if (message.result) {
          const result = message.result
          if (['preparing', 'running'].includes(result.status) && typeof result.execution_id === 'string') {
            executionId = result.execution_id
            void forwardInput()
          } else {
            complete(result)
          }
        }
      } else {
        const request = pending.get(message.id)
        if (request) {
          pending.delete(message.id)
          if (message.error) request.reject(message.error.data ?? message.error)
          else request.resolve(message.result)
        }
      }
      if (done || retrying) return
    }
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) fail({ code: 'PROTOCOL_ERROR', reason: 'RPC frame exceeds limit' })
  })
  rpc.stderr.on('data', () => {})
  rpc.on('error', fail)
  rpc.stdin.on('error', error => { if (!done && !retrying) fail(error) })
  rpc.on('close', () => {
    if (rpc === child && !done && !retrying) fail({ code: 'RPC_CLOSED', reason: 'connection closed before execution completed' })
  })
  // Resolve policy against the workspace, but preserve the caller's actual cwd.
  void send('explainPolicy', { policy: spec.policy, cwd: spec.cwd, network: spec.network }).then(explained => {
    if (done || rpc !== child) return
    const policy = { id: explained.policy_id, sandbox_level: explained.sandbox_level }
    for (const key of ['filesystem', 'network', 'environment', 'process', 'resources', 'approval']) {
      if (explained[key] !== undefined) {
        policy[key] = Object.fromEntries(Object.entries(explained[key]).filter(([, value]) => value !== null))
      }
    }
    if (policy.filesystem) delete policy.filesystem.unrestricted
    // RunSeal rejects inline read-only policies with empty write roots; use its named profile.
    rpc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'execute', params: {
      command: spec.argv, cwd: process.cwd(), policy: spec.policy === 'workspace-write' ? policy : spec.policy, network: spec.network,
      timeout_ms: spec.timeoutMs, stdin: { mode: 'stream' },
    } }) + '\n')
  }).catch(fail)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Disconnect is RunSeal's cancellation boundary, including admission before receipt.
    finish(signal === 'SIGINT' ? 130 : 143)
  })
}
start()
