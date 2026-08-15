// Scripted runseal rpc child for tests.
// FAKE_RUNSEAL_LINES is a JSON array; entries may be objects or pre-serialized strings.
const lines = JSON.parse(process.env.FAKE_RUNSEAL_LINES ?? '[]')
let responded = false
process.stdin.on('data', () => {
  if (responded) return
  responded = true
  setTimeout(() => {
    for (const line of lines) {
      process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
    }
  }, 50)
})
setInterval(() => {}, 1000)
