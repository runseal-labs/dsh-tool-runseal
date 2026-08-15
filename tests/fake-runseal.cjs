// Scripted runseal rpc child for tests.
// Invoked as: node fake-runseal.cjs rpc --stdio  (by the wrapper)
// or:          node fake-runseal.cjs setup windows-sandbox --cwd <ws> --elevate
const lines = JSON.parse(process.env.FAKE_RUNSEAL_LINES ?? '[]')
let index = 0
const setupOk = process.env.FAKE_SETUP_OK === '1'

if (process.argv.includes('setup')) {
  process.exit(setupOk ? 0 : 1)
}

process.stdin.on('data', () => {
  if (index >= lines.length) return
  const toSend = lines.slice(index)
  index = lines.length
  setTimeout(() => {
    for (const line of toSend) {
      process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n')
    }
  }, 30)
})
setInterval(() => {}, 1000)
