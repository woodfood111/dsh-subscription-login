# dsh-subscription-login

把非 DeepSeek 的 AI 订阅账号（ChatGPT Codex、Claude、GitHub Copilot、OpenRouter、Kimi Code、xAI SuperGrok/X Premium）接进 DeepSeek Harness —— **一个页面管全部**。

装在 **设置 → 插件 → 订阅登录** 里。它列出你这个部署**实际注册**的每一个登录流程，走完它，看到结果。

## 它和别的订阅插件不一样的地方

生态里已经有五六个同类插件，每个都硬编码自己的 provider。这个不硬编码任何东西：

- **列表来自 `ctx.authorization`**，由 `dsh-llm-pi-ai` 按"每个带登录的 pi-ai provider 注册一个 flow"填充。上游 pi-ai 加一家 provider，这里**自动出现**，本插件一行不用改。
- **它把缺的那道缝合上了。** 官方随附的 `web` profile **没有组合 `@deepseek-ai/dsh-authorization`**，而 `dsh-llm-pi-ai` 是在 `ctx.inject(['authorization'], …)` 里注册登录流程的。没有这个服务，适配器永远等不到它，**任何 provider 的登录流程都不会被注册**——这正是那些能用的订阅插件全都自己重写一遍 OAuth 的原因。本插件的 bundle 补丁把这一行带来，于是"一个通用控制台"才成立。
- **无主凭据会被列出来。** `llm-pi-ai` 作用域里、当前没有任何流程认领的记录（provider 不再提供登录、或提供者插件被卸载）会单独成节，可一键删除。官方文档明说"识别这种孤儿记录由调用方负责"，此前没人做。
- **诚实。** 登出只删本机记录，界面里就这么写，不假装吊销；未定价的东西不显示；宿主没有流程时显示"没有可登录的账号"而不是一个点不动的按钮。

## 安全

- **每个请求先过 `ctx.connection.requestRejection()`**：Host/Origin 栅栏（挡 DNS rebinding 与跨站调用）+ 浏览器登录态。裸请求（无会话 cookie）得到 **401**，不是 200。
- **密钥永不经过这个插件的任何一行。** 它只调用 `describeRecord()`，那个返回值里**没有能装密钥的字段**。登录流程本身跑在 `dsh-llm-pi-ai` 里，那是唯一的写入方，记录直接落进 DSH 凭据存储。
- **通知字段白名单投影。** notice 只保留 `message`/`url`/`code`，其它一律丢弃（有测试盯着）。
- **删除范围刻意窄。** 只有 `llm-pi-ai/<provider>` 这一族记录可列、可删。别的插件写的记录既不显示也不能在这里删。
- **请求体上限 64 KiB**，非 JSON 体得到 400 而不是崩溃。

## 安装

```sh
dsh plugin --profile web add dsh-subscription-login
```

然后**重启 `dsh web`**。

> ⚠️ 重启是必须的。bundle 补丁会插入两行（授权 seam + 本插件），而 profile 补丁的热重载在实测中**没有**对进程外的文件写入生效（见下面"验证到哪一步"）。改 profile 的 `dsh.profile.bundles` 之后，冷启动是唯一可靠的路径。

装完打开 **设置 → 插件 → 订阅登录**。

## 用法

每一行是一个可登录的账号：

- **登录** —— 点一下开始。流程会告诉你该打开哪个页面、该填什么码；需要你回答的问题（粘贴授权码、选择账号）会就地出现。随时可以**取消登录**。
- **登出** —— 两步确认。只删本机记录。
- **无主的登录凭据** —— 没有流程认领的旧记录，可删。

登录成功后，去官方的 **设置 → 模型** 页面就能看到对应 provider 的行和登录状态——本插件复用官方那条路，没有另起一套模型目录。

## 它不做什么

- **不自己实现 OAuth。** 协议在 pi-ai 里，刷新、跨进程锁都在那儿。本插件是界面和编排。
- **不做服务端吊销。** 授权 seam 没有吊销通道，登出就是删本地记录。
- **不做登录中断恢复。** 一次尝试只活在发起它的进程里，刷新页面要重来——这是 seam 的既有约束。
- **不替你做决定。** 不推荐用哪个 provider，不算额度，不做健康检查。

## 开发

```sh
npm test      # 52 个离线测试
npm run check # 发布守卫，npm publish 会先跑它
```

**没有构建步骤。** `lib/client.js` 是手写的客户端模块格式（`window.__ModuleLoader__.load` + 工厂函数），仓库里那个文件就是发布出去、也是实际运行的那个文件。`require("react")` 走 shell 的静态模块表。

测试分三层，都在 Node 里跑，不需要浏览器、不需要装 DSH：

| 文件 | 覆盖 |
|---|---|
| `test/registry.test.mjs` | 登录生命周期：通知、提问、回答、竞态撤回、取消、超时、失败、登出、卸载。用桩实现两个 seam 的**文档契约**，不是本插件的期望 |
| `test/router.test.mjs` | HTTP 形状：状态码、错误码、游标与超时钳制、路由匹配 |
| `test/host.test.mjs` | `apply()` 在桩 Cordis 上接线；**信任闸门先于一切**（被拒的请求不得到达 seam）；请求体解析与上限；卸载时取消在跑的登录 |
| `test/client.test.mjs` | 真实的 `lib/client.js` 配桩 `window.__ModuleLoader__` 与桩 React：注册、字典一致性、渲染、**点击登录走完一次尝试**并渲染出提问 |

## 验证到哪一步（诚实交代）

**真机端到端验证已完成**，方式是不打扰你：用一个**隔离的 `DSH_HOME`** 起第二个实例（端口 3099、独立会话存储），在那里验证完就关掉删除。你运行中的服务器全程没动过。

实机结果：

| 探针 | 结果 |
|---|---|
| 裸 `GET /plugins/dsh-subscription-login/flows` | **401** ✅ 路由已注册，信任闸门先于一切生效 |
| 带会话 cookie 请求同一路径 | **200**，返回真实载荷 ✅ |
| 裸 `POST .../attempts` | **401** ✅ 写路径同样受闸门保护 |
| 未知流程 | `404 NO_FLOW` ✅ |
| 未知登录方式 | `400 UNKNOWN_METHOD`，并列出真实可用的 `oauth, api-key` ✅ |
| 作用域外的登出 | `404 NO_RECORD`（不泄露该记录是否存在）✅ |
| 缺 key | `400 BAD_REQUEST` ✅ |
| 前缀下的未知路径（带 cookie） | `404 NOT_FOUND` ✅ |

**最有价值的一条**：`flows` 返回了 **40 个 provider 的登录流程**——这直接证明了我的诊断。没有补丁里那一行，这 40 个流程**一个都不会存在**。其中 **6 家带 OAuth**：

`anthropic`（Claude Pro/Max）、`openai-codex`（ChatGPT Plus/Pro）、`github-copilot`、`openrouter`、**`kimi-coding`（Sign in with Kimi Code）**、**`xai`（SuperGrok / X Premium）**。

后两家是我原来不知道的。那些硬编码 provider 的插件全都漏了它们——这正是"列表从 seam 读、不硬编码"的回报。

**真机验证还抓到一个真 bug。** `dsh-host-webserver` 匹配前缀路由用的是 `pathname === prefix || pathname.startsWith(prefix + '/')`。我最初把前缀注册成带尾斜杠的 `/plugins/dsh-subscription-login/`，于是匹配器去找 `...//flows`，**永远匹配不上**——只有裸路径命中，所有真实端点都掉进 SPA 回退变成 404。第一轮探针就是这个现象（`/plugins/dsh-subscription-login/` → 401，但 `/flows` → 404），修掉之后全绿。现在这条约束被 `test/host.test.mjs` 钉住了。

### 真实 provider 的完整 OAuth（GitHub Copilot，2026-09-18）

用免费 GitHub 账号在**用户自己的 DSH 实例**上跑完了一次真实 device flow，全程经本插件的 HTTP 接口驱动：

| 环节 | 实测结果 |
|---|---|
| 流程列表 | **39 个流程**，其中 **6 家带 OAuth**：Anthropic / GitHub Copilot / Kimi For Coding / OpenAI Codex / OpenRouter / xAI |
| 发起登录 | `POST attempts` → `attemptId=a1` ✅ |
| 流程**提问** | `GitHub Enterprise URL/domain (blank for github.com)` ✅ |
| 回答 | 空值 → `{"ok":true}`，流程继续 ✅ |
| 流程**通知** | `https://github.com/login/device` + 一次性码 `03B3-2CA7` ✅ |
| 人在 GitHub 授权 | 成功（GitHub 确认已登录 `woodfood111`）✅ |
| 换 Copilot token | **403**，结构化原因：`no_copilot_access`、`can_signup_for_limited: true` ✅ 被如实上报 |
| 失败后一致性 | 无半截凭据记录、无孤儿、key 已释放可立刻重试 ✅ |

也就是说：**人在环回路的每个环节都在真实 provider 流程上走通了**，唯一失败的是订阅权益本身——这正是预期的结果（免费账号）。而那条 403 带着明确的 `notification_id` 和注册链接，说明**失败是可诊断的，不是静默卡死**，这是本插件相对"自己重写 OAuth"的插件的核心差异。

顺带一提：`can_signup_for_limited: true` 说明该账号可以注册免费的 **Copilot Free**，注册后再跑一次同一条流程就会**成功并写入凭据**。

这次实跑还改进了失败信息的呈现：provider 的拒绝原样打印在一个独立的诊断块里（等宽、换行、不截断），而不是当成一行灰色小字——**不裁剪、不转述**，因为改写 provider 的话就是在编答案。

### 重跑这条流程时：失败后别立刻重试

GitHub 对未认证的 device flow 端点有频率限制，而这条路上很容易踩到。实测（同一天、同一台机器）：

| 次序 | 结果 |
|---:|---|
| 第 1 次 | 完整跑通：设备码 → 人工授权 → GitHub 返回结构化 403 |
| 第 2 次 | 设备码发出后约 30 秒 `fetch failed` |
| 第 3 次 | 约 11 秒 `fetch failed`，连设备码都没发出 |

同一时刻整机外网**是好的**：市场 1.5 秒拉完 3.5 MB，GitHub REST 也正常解析了 `github:` 依赖的 HEAD。所以那不是断网，是**被限流**。

插件这一侧不会因此卡住——`inFlight` 归零、key 立即释放、可以马上重发——**但重试再快也绕不过 GitHub 那侧的限制**。失败后等一段时间，再做**一次**干净尝试。

### 端到端成功：一条真实凭据被写进了 profile（OpenRouter，2026-09-18）

这是最后一格。用真实账号在跑 DSH 的桌面上走完 PKCE + 回环回调：

| 环节 | 实测结果 |
|---|---|
| 发起 | `attemptId=a9` ✅ |
| 流程通知 | 监听 `127.0.0.1:1960/oauth/callback/<uuid>`，并给出授权 URL ✅ |
| 人在浏览器授权 | 点了 Authorize ✅ |
| **回环回调** | 浏览器跳到 `127.0.0.1:1960`，**本机监听器自动接住，不需要粘贴任何 URL** ✅ |
| PKCE 兑换 + 提交记录 | 完成 ✅ |
| **流程结算** | `outcome=authorized` ✅ |
| **凭据落库** | `openrouter: configured=true, kind=grant` ✅ |
| 一致性 | 无孤儿、无 inFlight 残留 ✅ |

**这是"它真的能工作"的证据，而不只是"契约上应该能工作"。**

顺带还跑出了一处 UI 落差并已修掉：**登录成功 ≠ 模型可选**。凭据写进的是凭据存储，而模型选择器读的是 `llm-pi-ai` 的**路由**（`settings.yaml` 里当时没有 `openrouter` 段）。所以成功提示现在会补一句：若模型列表里还没有这个 provider，去「设置 → 模型」把它加为一条路由。本插件刻意不碰模型目录——那是官方模型页的职责——但必须把这一步说出来。

还没验证的：

- ⚠️ **客户端 UI 只在桩 React 里渲染过，没有在真浏览器里看过**：布局、样式、以及浏览器 fetch 是否真的打到宿主，需要你打开页面确认。上面那次成功是通过 HTTP 接口驱动的，等价于 UI 的每一步，但没经过 UI 的按钮。
- ⚠️ **GitHub Copilot 那条没有走到成功**：账号缺 Copilot 权益，且国内无梯子打不开 Copilot 的注册页。device flow 本身已完整验证过（见上）。

## 想拿到一次真正成功的登录

上表那次 403 里带着 `can_signup_for_limited: true` 和注册链接——也就是说这条路还差最后一步：

1. 去 <https://github.com/github-copilot/signup> 注册免费的 **Copilot Free**（不需要付费）
2. 回到 **设置 → 插件 → 订阅登录**，再点一次 GitHub Copilot 的登录
3. 同样的 device flow，这次会写进凭据；之后在 **设置 → 模型** 里就能选 Copilot 的模型

或者换 **OpenRouter**：它的 OAuth 是 PKCE，免费账号可走完，返回的是你自己的 API key，不看订阅——那条路能直接验到"凭据成功写入"。

## 上架

想进市场就往 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR（在市场本身提没用，市场只是读那个列表）。发布前 `npm run check` 会挡住五类事故：宿主半引入了 `@deepseek-ai/*`、客户端半 require 了 react 以外的东西、两个字典 key 不一致、补丁弄丢了授权 seam、测试不过。

## 许可

MIT
