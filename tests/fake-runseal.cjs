// Minimal protocol peer. Run as node fake-runseal.cjs [scenario] rpc --stdio.
const { createInterface } = require('node:readline')
const { AsyncLocalStorage } = require('node:async_hooks')
const scope = new AsyncLocalStorage()
const executions = new Map()
const lines = JSON.parse(process.env.FAKE_RUNSEAL_LINES ?? '[]')
const scenario = process.argv[2]
let sequence = 0
let timer
let pressureAttempts = 0
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const event = (type, extra = {}) => send({ jsonrpc: '2.0', method: 'event', params: { type, execution_id: scope.getStore().id, ...extra } })
function terminal(code = 0, extra = {}) {
  const executionId = scope.getStore().id
  event(extra.error ? 'execution.failed' : 'execution.finished', { result: { execution_id: executionId, status: extra.error ? 'failed' : 'finished', cleanup_complete: scenario !== 'unclean', exit_code: code, ...extra } })
}
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const request = JSON.parse(line)
  const executionId = request.method === 'execute' ? (executions.size ? `exec_fixture_${executions.size}` : 'exec_fixture') : request.params?.execution_id
  if (request.method === 'execute') executions.set(executionId, { id: executionId, input: [] })
  scope.run(executions.get(executionId), () => {
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
    setTimeout(() => {
      process.stdout.write(receipt)
      if (scenario === 'pty-preparing') return
      event('execution.started', { process_id: scenario === 'pty-no-pid' ? undefined : 12345 })
      if (scenario === 'shared') {
        event('execution.stdout', { data: 'base64:' + Buffer.from(JSON.stringify({ owner: process.pid, executionId, argv: request.params.command })).toString('base64') })
        if (!request.params.command.includes('hold')) terminal()
        return
      }
      if (scenario === 'argv') {
        event('execution.stdout', { data: `base64:${Buffer.from(JSON.stringify(request.params)).toString('base64')}` })
        terminal()
        return
      }
      if (scenario === 'owner-env') {
        event('execution.stdout', { data: 'base64:' + Buffer.from(JSON.stringify({ home: process.env.RUNSEAL_WINDOWS_SANDBOX_HOME, local: process.env.LOCALAPPDATA })).toString('base64') })
        terminal()
        return
      }
      if (scenario.startsWith('pty') || scenario === 'control' || scenario.startsWith('pressure')) return
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
    if (scenario.startsWith('pressure') && (++pressureAttempts <= 2 || scenario === 'pressure-cancel')) {
      event('execution.stdout', { data: 'base64:' + Buffer.from('PRESSURE_READY').toString('base64') })
      send({ jsonrpc: '2.0', id: request.id, error: { message: 'queue full', data: { code: 'INPUT_BACKPRESSURE', reason: 'queue full' } } })
      return
    }
    const input = scope.getStore().input
    input.push(Buffer.from(request.params.data.slice(7), 'base64'))
    if (scenario === 'pty' || scenario === 'control' || scenario.startsWith('pressure')) event(request.params.stream === 'control' ? 'execution.control' : scenario === 'pty' ? 'execution.terminal' : 'execution.stdout', { data: request.params.data })
    send({ jsonrpc: '2.0', id: request.id, result: { accepted_bytes: input.at(-1).length } })
  } else if (request.method === 'closeExecutionInput') {
    send({ jsonrpc: '2.0', id: request.id, result: {} })
    if (scenario === 'echo') {
      event('execution.stdout', { data: 'base64:' + Buffer.concat(scope.getStore().input).toString('base64') })
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
})
reader.on('close', () => { clearTimeout(timer); process.exit(0) })
