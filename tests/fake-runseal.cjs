// Minimal protocol peer. Run as node fake-runseal.cjs [scenario] rpc --stdio.
const { createInterface } = require('node:readline')
const lines = JSON.parse(process.env.FAKE_RUNSEAL_LINES ?? '[]')
const scenario = process.argv[2]
const executionId = 'exec_fixture'
let input = []
let sequence = 0
let timer
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const event = (type, extra = {}) => send({ jsonrpc: '2.0', method: 'event', params: { type, execution_id: executionId, ...extra } })
function terminal(code = 0, extra = {}) {
  event(extra.error ? 'execution.failed' : 'execution.finished', { result: { execution_id: executionId, status: extra.error ? 'failed' : 'finished', cleanup_complete: scenario !== 'unclean', exit_code: code, ...extra } })
}
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const request = JSON.parse(line)
  if (lines.length) {
    for (const payload of lines.splice(0)) process.stdout.write(payload + '\n')
    return
  }
  if (request.method === 'explainPolicy') {
    send({ jsonrpc: '2.0', id: request.id, result: { policy_id: request.params.policy, sandbox_level: request.params.policy, filesystem: { write: [request.params.cwd] } } })
  } else if (request.method === 'execute') {
    if (scenario === 'reject') {
      send({ jsonrpc: '2.0', id: request.id, error: { message: 'unavailable', data: { code: 'BACKEND_UNAVAILABLE', reason: 'no backend' } } })
      return
    }
    if (scenario === 'abrupt') return process.exit(0)
    const receipt = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { execution_id: executionId, status: 'preparing' } }) + '\n'
    process.stdout.write(receipt.slice(0, 17))
    setTimeout(() => {
      process.stdout.write(receipt.slice(17))
      if (scenario === 'pty-preparing') return
      event('execution.started', { process_id: scenario === 'pty-no-pid' ? undefined : 12345 })
      if (scenario === 'owner-env') {
        event('execution.stdout', { data: 'base64:' + Buffer.from(JSON.stringify({ home: process.env.RUNSEAL_WINDOWS_SANDBOX_HOME, local: process.env.LOCALAPPDATA })).toString('base64') })
        terminal()
        return
      }
      if (scenario.startsWith('pty') || scenario === 'control') return
      if (['cancel', 'cancel-delayed', 'echo', 'cancel-early'].includes(scenario)) {
        if (scenario !== 'echo') event('execution.stdout', { data: 'base64:UkVBRFk=' })
        return
      }
      timer = setTimeout(() => {
        if (scenario === 'failed') return terminal(null, { error: { code: 'EXECUTION_TIMEOUT', reason: 'deadline exceeded' } })
        const output = Buffer.from('你好')
        event('execution.stdout', { data: 'base64:' + output.subarray(0, 2).toString('base64') })
        event('execution.stdout', { data: 'base64:' + output.subarray(2).toString('base64') })
        event('execution.stderr', { data: 'base64:' + Buffer.from('diagnostic').toString('base64') })
        terminal(7, scenario === 'stream-only' ? {} : { stdout: '你好', stderr: 'diagnostic' })
      }, 180)
    }, scenario === 'cancel-early' ? 150 : 10)
  } else if (request.method === 'writeExecutionInput') {
    input.push(Buffer.from(request.params.data.slice(7), 'base64'))
    if (scenario === 'pty' || scenario === 'control') event(request.params.stream === 'control' ? 'execution.control' : scenario === 'pty' ? 'execution.terminal' : 'execution.stdout', { data: request.params.data })
    send({ jsonrpc: '2.0', id: request.id, result: { accepted_bytes: input.at(-1).length } })
  } else if (request.method === 'closeExecutionInput') {
    send({ jsonrpc: '2.0', id: request.id, result: {} })
    if (scenario === 'echo') {
      event('execution.stdout', { data: 'base64:' + Buffer.concat(input).toString('base64') })
      terminal()
    }
  } else if (request.method === 'signalExecution' || request.method === 'resizeExecution') {
    send({ jsonrpc: '2.0', id: request.id, result: { accepted: true, sequence: ++sequence } })
    if (request.method === 'signalExecution' && scenario === 'pty-exit-after-delivery') { event('execution.signal_delivered', { sequence, target_process_id: 12345, target_process_group_id: 23456 }); terminal(); return }
    if (request.method === 'signalExecution' && scenario === 'pty-unconfirmed') { setTimeout(() => terminal(), 40); return }
    if (request.method === 'signalExecution') { const current = sequence; setTimeout(() => event('execution.signal_delivered', { sequence: current, target_process_id: 12345, target_process_group_id: 23456 }), 80) }
    event('execution.terminal', { data: 'base64:' + Buffer.from(request.method).toString('base64') })
  } else if (request.method === 'cancelExecution') {
    send({ jsonrpc: '2.0', id: request.id, result: { accepted: true } })
    timer = setTimeout(() => terminal(null, { error: { code: 'EXECUTION_CANCELLED', reason: 'cancelled' } }), scenario === 'cancel-delayed' ? 180 : 10)
  }
})
reader.on('close', () => { clearTimeout(timer); process.exit(0) })
