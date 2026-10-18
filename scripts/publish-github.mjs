/**
 * One-shot publisher: create the GitHub repository and push the working tree
 * into it through the Git Data API.
 *
 * No git binary is involved: blobs, one tree, one commit, one ref. That keeps
 * the machine untouched and, more to the point, keeps the token out of any
 * `.git/config` on disk.
 *
 * The token comes from `GH_TOKEN`/`GITHUB_TOKEN` when set, otherwise from
 * `.secrets/github-token.txt`. It is used only in an Authorization header and
 * never written to stdout; a token file is deleted once the push has succeeded.
 */
import { readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'H:/dzjpmjdjb/dsh-subscription-login'
const TOKEN_PATH = join(ROOT, '.secrets', 'github-token.txt')
const API = 'https://api.github.com'
const REPO = 'dsh-subscription-login'
const DESCRIPTION =
  'Subscription sign-in console for DeepSeek Harness: one settings page for every OAuth sign-in the harness can offer, read from the authorization seam instead of hardcoded providers.'
const TOPICS = ['dsh-plugin', 'dsh', 'deepseek-harness', 'oauth', 'deepseek']
/** Commit message; a caller can override it for a follow-up sync. */
const COMMIT_MESSAGE =
  (process.env.GH_COMMIT_MESSAGE ?? '').trim() ||
  'Release 0.1.2: boot fix for DSH 0.1.7-rc.2+\n\nThe authorization row now uses its own loader id and backs off when dsh-base already mounts the seam, so a profile no longer fails with duplicate loader entry id "authorization". README documents the compatibility and release notes.'

/** Top-level entries that make up the published repository. Anything else is local. */
const INCLUDE = new Set([
  '.gitignore',
  'LICENSE',
  'PUBLISHING.zh.md',
  'README.md',
  'README.zh.md',
  'cordis.patch.yml',
  'lib',
  'package.json',
  'publishing',
  'scripts',
  'test',
])

/** Per-file exclusions that must never reach the repository, even inside an included directory. */
const SKIP_FILE = /(?:\.tgz|\.npmrc|\.log|\.bak[-.][^\\/]*)$/i

if (process.argv.includes('--list')) {
  for (const file of walk(ROOT).sort()) console.log(relative(ROOT, file).split('\\').join('/'))
  process.exit(0)
}

// Take the last whitespace-separated run so a stray placeholder line above the
// token cannot break the read, and never echo any of it. An environment token
// wins over the file so a caller can avoid writing the secret to disk at all.
const envToken = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim()
const fileToken = existsSync(TOKEN_PATH)
  ? readFileSync(TOKEN_PATH, 'utf8').trim().split(/\s+/).pop()
  : undefined
const token = envToken !== '' ? envToken : fileToken
if (token === undefined || token === '') {
  console.error(`找不到 GitHub token：设置 GH_TOKEN 环境变量，或写入 ${TOKEN_PATH}`)
  process.exit(1)
}
if (!/^(ghp_|github_pat_|gho_)/.test(token)) {
  console.error('token 格式不对：既不是 ghp_、github_pat_ 也不是 gho_ 开头')
  process.exit(1)
}
const tokenFromFile = envToken === '' && fileToken !== undefined

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-subscription-login-publisher',
  'x-github-api-version': '2022-11-28',
}

/** One API call, returning status and parsed body. */
async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = text === '' ? {} : JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 300) }
  }
  return { status: response.status, ok: response.ok, json }
}

/** Every publishable file under the package root. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (dir === ROOT && !INCLUDE.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (!SKIP_FILE.test(entry.name)) out.push(full)
  }
  return out
}

// --- 1. who is this token ---------------------------------------------------

const me = await api('GET', '/user')
if (!me.ok) {
  console.error(`token 校验失败：HTTP ${me.status} — ${me.json.message ?? ''}`)
  process.exit(1)
}
console.log(`✓ token 有效，身份：${me.json.login}`)
const owner = me.json.login

// --- 2. create the repository ----------------------------------------------

let created = await api('POST', '/user/repos', {
  name: REPO,
  description: DESCRIPTION,
  homepage: `https://github.com/${owner}/${REPO}`,
  private: false,
  has_issues: true,
  has_wiki: false,
  has_projects: false,
  auto_init: false,
})
if (created.status === 201) {
  console.log(`✓ 仓库已创建：${created.json.html_url}`)
} else if (created.status === 422) {
  const existing = await api('GET', `/repos/${owner}/${REPO}`)
  if (!existing.ok) {
    console.error(`仓库已存在但读不到：HTTP ${existing.status}`)
    process.exit(1)
  }
  console.log(`· 仓库已存在，继续推送：${existing.json.html_url}`)
} else {
  console.error(`建仓库失败：HTTP ${created.status} — ${created.json.message ?? JSON.stringify(created.json)}`)
  process.exit(1)
}

// --- 3. bootstrap a base commit, only on an empty repository ----------------

// A brand-new repository refuses the Git Data API with 409 until it has a
// commit, so the first file goes in through the Contents API. On an existing
// repository this must be skipped: doing it again would push a second
// "Initialize repository" commit ahead of every sync.
let refInfo = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/main`)
if (!refInfo.ok) {
  const bootstrap = await api('PUT', `/repos/${owner}/${REPO}/contents/.gitignore`, {
    message: 'Initialize repository',
    content: readFileSync(join(ROOT, '.gitignore')).toString('base64'),
  })
  if (!bootstrap.ok) {
    console.error(`初始提交失败：HTTP ${bootstrap.status} — ${bootstrap.json.message ?? ''}`)
    process.exit(1)
  }
  refInfo = await api('GET', `/repos/${owner}/${REPO}/git/ref/heads/main`)
}

if (!refInfo.ok) {
  console.error(`读 main 失败：HTTP ${refInfo.status}`)
  process.exit(1)
}
const baseSha = refInfo.json.object.sha
const baseCommit = await api('GET', `/repos/${owner}/${REPO}/git/commits/${baseSha}`)
const baseTree = baseCommit.json.tree.sha

// --- 4. push the tree as one commit ----------------------------------------

const files = walk(ROOT).sort()
console.log(`· 待推送 ${files.length} 个文件`)

const tree = []
for (const file of files) {
  const path = relative(ROOT, file).split('\\').join('/')
  const content = readFileSync(file)
  const blob = await api('POST', `/repos/${owner}/${REPO}/git/blobs`, {
    content: content.toString('base64'),
    encoding: 'base64',
  })
  if (!blob.ok) {
    console.error(`建 blob 失败：${path} — HTTP ${blob.status} ${blob.json.message ?? ''}`)
    process.exit(1)
  }
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.json.sha })
}

const treeResult = await api('POST', `/repos/${owner}/${REPO}/git/trees`, { base_tree: baseTree, tree })
if (!treeResult.ok) {
  console.error(`建 tree 失败：HTTP ${treeResult.status} — ${treeResult.json.message ?? ''}`)
  process.exit(1)
}

const commit = await api('POST', `/repos/${owner}/${REPO}/git/commits`, {
  message: COMMIT_MESSAGE,
  tree: treeResult.json.sha,
  parents: [baseSha],
})
if (!commit.ok) {
  console.error(`建 commit 失败：HTTP ${commit.status} — ${commit.json.message ?? ''}`)
  process.exit(1)
}

const ref = await api('PATCH', `/repos/${owner}/${REPO}/git/refs/heads/main`, {
  sha: commit.json.sha,
  force: true,
})
if (!ref.ok) {
  console.error(`更新分支失败：HTTP ${ref.status} — ${ref.json.message ?? ''}`)
  process.exit(1)
}
console.log(`✓ 已推送 ${files.length} 个文件到 main（commit ${commit.json.sha.slice(0, 7)}）`)

// --- 5. topics --------------------------------------------------------------

const topics = await api('PUT', `/repos/${owner}/${REPO}/topics`, { names: TOPICS })
if (topics.ok) console.log(`✓ topic：${TOPICS.join(', ')}`)
else console.log(`⚠ topic 设置失败：HTTP ${topics.status}（可以到仓库页面手动加 dsh-plugin）`)

// --- 6. burn the token file (only when the file was the source) ------------

if (tokenFromFile) {
  rmSync(TOKEN_PATH, { force: true })
  console.log('✓ 已删除 .secrets/github-token.txt')
} else {
  console.log('· token 来自环境变量，未写入磁盘')
}

console.log(`\n仓库地址：https://github.com/${owner}/${REPO}`)
console.log(`创建时间就是现在——1 天年龄门槛从此刻开始计时。`)
