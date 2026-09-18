# 上架清单

目标：让 `dsh-subscription-login` 出现在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 列表里，从而进入 dsh-market 的插件市场。

规则来自 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)：**一个 PR 只加一个文件**，`data/plugins/<owner>__<repo>.yml`。两个 README 都是脚本生成的，不要手工改。

## 已经做完的

- [x] `package.json` 声明了 `dsh.bundle.patch`（CI 的第一个硬门槛）
- [x] 根目录有 `cordis.patch.yml`
- [x] `package.json` 的 `repository` / `homepage` / `bugs` 指向目标仓库
- [x] npm 包体校验通过：`npm publish --dry-run` → 9 个文件、30.6 kB，`prepublishOnly` 守卫通过
- [x] 包名 `dsh-subscription-login` 在 npm 上**未被占用**
- [x] PR 条目文件已写好：`publishing/woodfood111__dsh-subscription-login.yml`
- [x] 代码是真能跑的（53 个测试 + 真机端到端，见 README）

## 还差的

- [x] **仓库已创建并推送**：<https://github.com/woodfood111/dsh-subscription-login>（18 个文件，`dsh-plugin` topic 已打，内容已核验：`.secrets` / `research` / `node_modules` 均未泄漏）

推送走的是 GitHub **Git Data API**（`scripts/publish-github.mjs`），没有在本机安装 git。改完代码重跑一次该脚本即可增量同步。

| 缺什么 | 现状 | 怎么补 |
|---|---|---|
| **仓库满 1 天** | 创建于 `2026-09-18 22:05`（北京时间） | CI 硬门槛，等到次日 22:05 之后 |
| **npm 凭据** | 无 `~/.npmrc` | `npm login`（可选：不发 npm 也能收录，只是没有下载量数字） |
| **提 PR 用的 token** | 上一次的 token 文件已按约定删除 | 提 PR 时再放一个新 token 到 `.secrets/github-token.txt` |

## 步骤

### 1. 建仓库（这一步越早越好）

仓库**必须创建满 1 天**才能被收录，CI 自动校验。所以先建，时钟才开始走。

在 GitHub 上建 `woodfood111/dsh-subscription-login`，然后：

- 给仓库加 **`dsh-plugin`** topic（这是硬性要求之一）
- 不要建成 README-only 仓库——"有真实可用的代码"也是门槛

### 2. 推代码

```sh
cd H:\dzjpmjdjb\dsh-subscription-login
git init -b main
git add -A
git commit -m "Subscription sign-in console for DeepSeek Harness"
git remote add origin https://github.com/woodfood111/dsh-subscription-login.git
git push -u origin main
```

> `publishing/` 和 `research/` 不会被 npm 发布（`files` 字段只放 `lib`、补丁、README、LICENSE），但它们会进 git 仓库。想干净点就加一个 `.gitignore` 把 `research/` 排掉。

### 3.（推荐）发 npm

不上 npm 也能被收录，但发了之后：安装免 `allowBuilds` 构建授权、市场能显示下载量。

```sh
npm login
npm publish
```

`prepublishOnly` 会自动跑 `scripts/prepublish-check.mjs`——五类事故会在发布前被挡住：宿主半引入了 `@deepseek-ai/*`、客户端半 require 了 react 以外的东西、两个字典 key 不一致、补丁弄丢了授权 seam、测试不过。

⚠️ 发布后 `package.json` 的 `repository` 必须指回被收录的那个仓库，否则 npm 与条目不会关联（这一条已经写好了）。

### 4. 提 PR（仓库满 1 天之后）

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，把 `publishing/woodfood111__dsh-subscription-login.yml` 放到：

```
data/plugins/woodfood111__dsh-subscription-login.yml
```

**只加这一个文件**，别动 README，也别动别人的条目。

## 条目内容（已按规则写好）

```yaml
url: https://github.com/woodfood111/dsh-subscription-login
name: woodfood111/dsh-subscription-login
category: identity
description:
  en: '...'
  zh: '...'
```

几点说明：

- **`category: identity`**（身份与通信）。同类的账号登录插件（如 `dsh-codex-auth-plugin`）都在这一类。分类选得不完美不会被打回——维护者会直接改。
- **描述里没有营销词、没有数字**。规则明写："描述必须属实……会被当作对你插件的声明，并与代码核对。夸大是让一个本来不错的插件被打回的主要原因。" 这一条我按代码写死了范围：列表读授权 seam、覆盖 6 家带 OAuth 的 provider、列出无人认领的旧记录。
- 英文描述里有 `—` 和 `(`，没有裸的 `: `，不需要引号；中文用了全角冒号，也加了引号（无害）。

## CI 会依次检查

1. 每个 PR 最多 3 条条目
2. `package.json` 里有 `dsh.bundle`（只声明 `dsh.client` 会在这里挂）
3. 仓库创建满 1 天
4. `awesome-lint` 与站点构建（双语一致性、分隔符、日期）

任何一条不过都会明确指出改什么，在同一个分支上推修复即可，不用重开 PR。
