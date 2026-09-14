// Wails' class-style JS bindings contain Go-derived JSDoc. Emit declarations
// from those, rather than maintaining a second handwritten IPC contract.
import { readdirSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const bindings = resolve(root, 'bindings')
const entry = 'bindings/github.com/ys-ll/uniterm/app.js'
if (!existsSync(resolve(root, entry))) {
  throw new Error('Generate Wails bindings first: wails3 generate bindings')
}

// TypeScript prefers adjacent declarations over JS imports. Remove only the
// generated declarations so repeated runs always infer the latest Go models.
function removeDeclarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) removeDeclarations(path)
    else if (entry.name.endsWith('.d.ts')) rmSync(path)
  }
}
removeDeclarations(bindings)
const result = spawnSync(process.execPath, [
  require.resolve('typescript/lib/tsc.js'),
  '--allowJs', '--declaration', '--emitDeclarationOnly', '--skipLibCheck',
  '--moduleResolution', 'bundler', '--module', 'ESNext', '--target', 'ES2020',
  '--rootDir', 'bindings', '--outDir', 'bindings', entry,
], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
