/**
 * The confined-execution wrapper spawned by dsh consumers. `confine()` returns
 * `[node, wrapper, <spec>]`; this script runs the command through the runseal RPC
 * `execute`, forwards stdout/stderr events to its own stdio, and exits with the
 * command's exit code — so the caller sees an ordinary subprocess lifecycle.
 *
 * Arguments: `node wrapper.cjs <executable> <spec-json>`
 * The spec JSON carries the argv, cwd, policy id, network mode, and timeout.
 * @module dsh-tool-runseal/wrapper
 */

const { spawn } = require('node:child_process')

const [, , executable, specJson] = process.argv
const spec = JSON.parse(specJson)

const child = spawn(executable, ['rpc', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
let exited = false
let exitCode = 1

const finish = (code) => {
  if (exited) return
  exited = true
  process.exitCode = code
  // Let stdout/stderr buffers flush before the child is reaped; runseal may
  // still be writing the final result frame.
  setTimeout(() => child.kill(), 100)
}

// Streamed stdout/stderr events are base64 payloads; the final result carries the
  // complete output. Use the RESULT's authoritative stdout/stderr (single write);
  // events remain only for the exit code and as a fallback when the result lacks
  // output fields (e.g. output truncation).
  let resultReceived = false
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.method === 'event' && message.params) {
        const event = message.params
        if (event.type === 'execution.finished' && typeof event.exit_code === 'number') {
          exitCode = event.exit_code
        }
      } else if (message.id === 1 && message.result) {
        if (typeof message.result.exit_code === 'number') exitCode = message.result.exit_code
        if (!resultReceived) {
          resultReceived = true
          if (typeof message.result.stdout === 'string') process.stdout.write(message.result.stdout)
          if (typeof message.result.stderr === 'string') process.stderr.write(message.result.stderr)
        }
        finish(exitCode)
      } else if (message.id === 1 && message.error) {
        const data = message.error.data ?? {}
        process.stderr.write(`runseal: ${data.reason ?? message.error.message}\n`)
        finish(2)
      }
    }
  })

child.stderr.on('data', () => {
  // drain; runseal diagnostics are not command output
})

child.on('exit', () => {
  if (!exited) finish(exitCode)
})

process.stdin.on('data', (chunk) => {
  // The wrapper does not forward stdin to the sandboxed command (runseal's
  // execute stdin is bytes/file based); drain to avoid backpressure.
  void chunk
})

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'execute',
  params: {
    command: spec.argv,
    cwd: spec.cwd,
    policy: spec.policy,
    ...spec.network ? { network: spec.network } : {},
    ...spec.timeoutMs ? { timeout_ms: spec.timeoutMs } : {},
  },
}) + '\n')

setTimeout(() => child.stdin.end(), 100)