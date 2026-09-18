/**
 * Release guard: the invariants that make this plugin installable and safe,
 * checked before `npm publish` rather than after a user hits them.
 *
 * Three of these are easy to break by accident while editing and invisible in
 * review:
 *
 *  - the host half must not import `@deepseek-ai/*`, because a plugin installed
 *    outside the harness repository cannot rely on resolving those specifiers
 *    from its own location (it reaches every seam through `ctx` instead);
 *  - the browser half must not import anything but `react`, because the client
 *    module loader resolves only the shell's static module table;
 *  - the dictionaries must carry identical key sets, or one language renders
 *    raw keys.
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

/** Read one file relative to the package root. */
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/** Record a failed invariant. */
const fail = (message) => failures.push(message)

// --- files the manifest promises -------------------------------------------

const manifest = JSON.parse(read('package.json'))
for (const relative of ['lib/index.js', 'lib/client.js', 'lib/registry.js', 'lib/router.js', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE']) {
  if (!existsSync(join(root, relative))) fail(`missing file: ${relative}`)
}
for (const relative of manifest.files ?? []) {
  if (!existsSync(join(root, relative))) fail(`package.json "files" names a path that does not exist: ${relative}`)
}

// --- manifest shape ---------------------------------------------------------

if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must point at ./cordis.patch.yml')
if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"')
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  fail('dsh.client.inject must list the client packages this plugin needs')
}
if (manifest.exports?.['./client'] !== './lib/client.js') fail('exports["./client"] must point at ./lib/client.js')
if (manifest.exports?.['./cordis.patch.yml'] === undefined) fail('exports must expose ./cordis.patch.yml')

// --- the two halves stay in their lanes ------------------------------------

const HOST_FILES = ['lib/index.js', 'lib/registry.js', 'lib/router.js']
for (const relative of HOST_FILES) {
  if (relative === 'lib/registry.js') continue
  const source = read(relative)
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  for (const specifier of imports) {
    if (specifier.startsWith('@deepseek-ai/')) {
      fail(`${relative} imports ${specifier}; the host half must reach every seam through ctx, not an import`)
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('node:')) {
      fail(`${relative} imports ${specifier}; only relative and node: builtins are allowed`)
    }
  }
}

const clientSource = read('lib/client.js')
const clientImports = [...clientSource.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
for (const specifier of clientImports) {
  if (specifier !== 'react') fail(`lib/client.js requires ${specifier}; the client loader resolves only react`)
}
if (!clientSource.includes('window.__ModuleLoader__.load(')) {
  fail('lib/client.js must register through window.__ModuleLoader__.load')
}
if (/^\s*(import|export)\s/m.test(clientSource)) {
  fail('lib/client.js must not use ESM syntax; the client module format is a plain factory')
}

// --- dictionaries stay in step ---------------------------------------------

const zhBlock = clientSource.slice(clientSource.indexOf('const zh = {'), clientSource.indexOf('const en = {'))
const enBlock = clientSource.slice(clientSource.indexOf('const en = {'), clientSource.indexOf('const STYLE_ID'))
const keysOf = (block) => [...block.matchAll(/^\s{6}"([^"]+)":/gm)].map((match) => match[1]).sort()
const zhKeys = keysOf(zhBlock)
const enKeys = keysOf(enBlock)
if (zhKeys.length === 0) fail('could not read the zh dictionary keys')
else if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys)) {
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))
  const missingInZh = enKeys.filter((key) => !zhKeys.includes(key))
  fail(`dictionaries disagree: missing in en [${missingInEn.join(', ')}], missing in zh [${missingInZh.join(', ')}]`)
} else {
  notes.push(`dictionaries agree on ${zhKeys.length} keys`)
}

// --- the patch brings the seam ---------------------------------------------

const patch = read('cordis.patch.yml')
if (!patch.includes('@deepseek-ai/dsh-authorization')) {
  fail('cordis.patch.yml must insert @deepseek-ai/dsh-authorization; the shipped web profile does not compose it')
}
if (!patch.includes("name: 'dsh-subscription-login'")) fail('cordis.patch.yml must insert this plugin')

// --- tests actually pass ----------------------------------------------------

const test = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
const summary = (test.stdout ?? '').split('\n').filter((line) => line.startsWith('# ')).join('\n')
if (test.status !== 0) {
  fail(`tests failed:\n${summary}`)
} else {
  const passLine = (test.stdout ?? '').split('\n').find((line) => line.startsWith('# pass '))
  notes.push(`tests passed (${passLine ?? 'unknown count'})`)
}

// --- report -----------------------------------------------------------------

for (const note of notes) console.log(`  ok  ${note}`)
if (failures.length > 0) {
  console.error('\nprepublish-check failed:')
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('  ok  release guard passed')
