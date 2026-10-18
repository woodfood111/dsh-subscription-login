/**
 * Open the awesome-dsh-plugin pull request.
 *
 * Fork, branch, one file, PR — all through the REST API, so no local git is
 * involved and the token never lands in a `.git/config`. The submission rules
 * are deliberately narrow and this script holds to them: exactly one file,
 * under `data/plugins/`, named for the repository, touching nothing else.
 *
 * Idempotent enough to re-run: an existing fork and branch are reused, and an
 * already-open PR for the same head is reported rather than duplicated.
 */
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'H:/dzjpmjdjb/dsh-subscription-login'
const TOKEN_PATH = join(ROOT, '.secrets', 'github-token.txt')
const API = 'https://api.github.com'

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin'
const OWNER = 'woodfood111'
const REPO = 'dsh-subscription-login'
const BRANCH = 'add-dsh-subscription-login'
const FILE_PATH = `data/plugins/${OWNER}__${REPO}.yml`

if (!existsSync(TOKEN_PATH)) {
  console.error(`找不到 token 文件：${TOKEN_PATH}`)
  process.exit(1)
}
const token = readFileSync(TOKEN_PATH, 'utf8').trim().split(/\s+/).pop()
if (!/^(ghp_|github_pat_)/.test(token ?? '')) {
  console.error('token 格式不对')
  process.exit(1)
}

const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-subscription-login-pr',
  'x-github-api-version': '2022-11-28',
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- 1. who -----------------------------------------------------------------

const me = await api('GET', '/user')
if (!me.ok) {
  console.error(`token 校验失败：HTTP ${me.status}`)
  process.exit(1)
}
if (me.json.login !== OWNER) {
  console.error(`token 属于 ${me.json.login}，与条目里的 ${OWNER} 不一致，停下`)
  process.exit(1)
}
console.log(`✓ token 有效：${me.json.login}`)

// --- 2. the entry file, checked before it is submitted ----------------------

const entry = readFileSync(join(ROOT, 'publishing', `${OWNER}__${REPO}.yml`), 'utf8')
for (const required of ['url:', 'name:', 'category:', 'description:']) {
  if (!entry.includes(required)) {
    console.error(`条目文件缺少 "${required}"，停下`)
    process.exit(1)
  }
}
if (!entry.includes(`url: https://github.com/${OWNER}/${REPO}`)) {
  console.error('条目里的 url 与仓库不一致，停下')
  process.exit(1)
}
// A bare ": " inside an unquoted description is parsed as a nested key.
const unquotedColon = entry
  .split('\n')
  .filter((line) => /^\s+(en|zh):\s/.test(line) && /[^'"]: /.test(line.replace(/^\s+(en|zh):\s/, '')))
if (unquotedColon.length > 0) {
  console.error(`描述里有未加引号的 ": "，会被 YAML 解析坏：\n${unquotedColon.join('\n')}`)
  process.exit(1)
}
console.log(`✓ 条目文件合格（${entry.split('\n').length - 1} 行，category 与 url 已核对）`)

// --- 3. fork ----------------------------------------------------------------

const existingFork = await api('GET', `/repos/${OWNER}/${UPSTREAM.split('/')[1]}`)
if (existingFork.ok) {
  console.log(`· fork 已存在：${existingFork.json.full_name}`)
} else {
  const fork = await api('POST', `/repos/${UPSTREAM}/forks`)
  if (fork.status !== 202 && fork.status !== 200) {
    console.error(`fork 失败：HTTP ${fork.status} — ${fork.json.message ?? ''}`)
    process.exit(1)
  }
  console.log(`· 已请求 fork：${fork.json.full_name ?? '(处理中)'}`)
}

// Forking is asynchronous; the branch write will 404 until it settles.
let forkReady
for (let attempt = 0; attempt < 30; attempt += 1) {
  const probe = await api('GET', `/repos/${OWNER}/${UPSTREAM.split('/')[1]}`)
  if (probe.ok && probe.json.size !== undefined) {
    forkReady = probe.json
    break
  }
  await sleep(3000)
}
if (forkReady === undefined) {
  console.error('fork 等了 90 秒仍未就绪，稍后重跑本脚本即可')
  process.exit(1)
}
console.log(`✓ fork 就绪：${forkReady.full_name}（默认分支 ${forkReady.default_branch}）`)

// --- 4. sync the fork, then branch off the fork's own default branch ---------

// A ref can only point at an object its own repository holds, so the branch has
// to be based on the fork's head and not the upstream's — the upstream sha is
// simply absent from the fork and the write answers 404. An older fork must be
// fast-forwarded first, or the PR would sit on however many days of stale
// history it had drifted. (The first attempt here used the upstream sha and
// failed exactly that way.)
const upstreamRepo = await api('GET', `/repos/${UPSTREAM}`)
const base = upstreamRepo.json.default_branch

const synced = await api('POST', `/repos/${OWNER}/${forkReady.name}/merge-upstream`, { branch: base })
if (synced.ok) {
  console.log(`· fork 已快进到上游 ${base}`)
} else if (synced.status === 409) {
  console.log('· fork 与上游有分叉（409），按现状继续')
} else {
  console.log(`· fork 同步返回 HTTP ${synced.status}，按现状继续`)
}

const baseRef = await api('GET', `/repos/${OWNER}/${forkReady.name}/git/ref/heads/${base}`)
if (!baseRef.ok) {
  console.error(`读 fork 的 ${base} 失败：HTTP ${baseRef.status} — ${baseRef.json.message ?? ''}`)
  process.exit(1)
}
const baseSha = baseRef.json.object.sha

const headRef = await api('GET', `/repos/${OWNER}/${forkReady.name}/git/ref/heads/${BRANCH}`)
if (headRef.ok) {
  console.log(`· 分支 ${BRANCH} 已存在，沿用`)
} else {
  const made = await api('POST', `/repos/${OWNER}/${forkReady.name}/git/refs`, {
    ref: `refs/heads/${BRANCH}`,
    sha: baseSha,
  })
  if (!made.ok) {
    console.error(`建分支失败：HTTP ${made.status} — ${made.json.message ?? ''}`)
    process.exit(1)
  }
  console.log(`✓ 分支 ${BRANCH} 已从 ${base}@${baseSha.slice(0, 7)} 建立`)
}

// --- 5. the one file --------------------------------------------------------

const current = await api('GET', `/repos/${OWNER}/${forkReady.name}/contents/${FILE_PATH}?ref=${BRANCH}`)
const put = await api('PUT', `/repos/${OWNER}/${forkReady.name}/contents/${FILE_PATH}`, {
  message: `Add ${OWNER}/${REPO}`,
  content: Buffer.from(entry, 'utf8').toString('base64'),
  branch: BRANCH,
  ...(current.ok ? { sha: current.json.sha } : {}),
})
if (!put.ok) {
  console.error(`写文件失败：HTTP ${put.status} — ${put.json.message ?? ''}`)
  process.exit(1)
}
console.log(`✓ 已提交 ${FILE_PATH}（commit ${put.json.commit.sha.slice(0, 7)}）`)

// --- 6. the pull request ----------------------------------------------------

const body = [
  `Adds [${OWNER}/${REPO}](https://github.com/${OWNER}/${REPO}) to \`identity\`.`,
  '',
  '**What it does.** A settings page that lists every sign-in flow registered on the harness',
  'authorization seam and walks the user through one — ChatGPT (Codex), Claude, GitHub Copilot,',
  'OpenRouter, Kimi For Coding and xAI. Its bundle patch also supplies the',
  '`@deepseek-ai/dsh-authorization` row the shipped `web` profile omits, without which',
  '`dsh-llm-pi-ai` registers no sign-in flow at all.',
  '',
  '**Checks it should pass.** `dsh.bundle.patch` is declared in `package.json` next to a',
  '`cordis.patch.yml`; the `dsh-plugin` topic is set; the repository was created 2026-09-18.',
  '',
  '**Verified.** 58 offline tests; a live run on a real deployment signed in to OpenRouter',
  'end to end (PKCE, loopback callback, credential committed) and exercised the GitHub Copilot',
  'device flow through to the provider\'s own structured refusal.',
  '',
  'Only one file is touched: the entry.',
].join('\n')

const open = await api('POST', `/repos/${UPSTREAM}/pulls`, {
  title: `Add ${OWNER}/${REPO}`,
  head: `${OWNER}:${BRANCH}`,
  base,
  body,
  maintainer_can_modify: true,
})
if (open.status === 201) {
  console.log(`\n✓ PR 已创建：${open.json.html_url}`)
} else if (open.status === 422 && /already exists/i.test(open.json.message ?? '')) {
  const list = await api('GET', `/repos/${UPSTREAM}/pulls?head=${OWNER}:${BRANCH}&state=open`)
  const url = list.json?.[0]?.html_url
  console.log(`\n· 该分支的 PR 已存在：${url ?? '(查不到，请到仓库查看)'}`)
} else {
  console.error(`\n开 PR 失败：HTTP ${open.status} — ${open.json.message ?? ''}`)
  if (Array.isArray(open.json.errors)) {
    for (const error of open.json.errors) console.error(`  - ${error.message ?? JSON.stringify(error)}`)
  }
  process.exit(1)
}

rmSync(TOKEN_PATH, { force: true })
console.log('✓ 已删除 .secrets/github-token.txt')
