import { existsSync } from 'node:fs'

try {
  // Source checkouts have not built lib yet; npm tarballs never include src.
  if (existsSync(new URL('../src/binary.ts', import.meta.url))) {
    console.log('RunSeal source checkout: skipping native download; build and pack to test installation.')
  } else {
    const { installBinary } = await import('../lib/binary.js')
    const path = await installBinary()
    if (path) console.log(`RunSeal installed: ${path}`)
  }
} catch (error) {
  console.error(`RunSeal installation failed: ${error.message}`)
  console.error('Check network access to GitHub releases and retry npm rebuild dsh-tool-runseal. To use a custom executable, install with RUNSEAL_SKIP_DOWNLOAD=1 and configure its path.')
  process.exitCode = 1
}
