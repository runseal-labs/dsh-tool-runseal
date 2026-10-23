import { copyFileSync } from 'node:fs'
copyFileSync('src/wrapper.cjs', 'lib/wrapper.cjs')
copyFileSync('src/executable.cjs', 'lib/executable.cjs')
copyFileSync('src/executable.d.cts', 'lib/executable.d.cts')
