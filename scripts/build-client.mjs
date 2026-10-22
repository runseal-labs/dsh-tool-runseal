import { build } from 'esbuild'

// dsh loads browser plugins as module-table factories, not standalone ESM.
await build({
  entryPoints: ['src/client.ts'], outfile: 'lib/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-tool-runseal", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
