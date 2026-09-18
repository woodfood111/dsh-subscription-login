/**
 * dsh-subscription-login — browser half.
 *
 * A "订阅登录台" tab inside Settings → Plugins. It lists every sign-in the
 * deployment can offer and walks one through it: the page a human must open,
 * the one-time code to submit, the question a flow cannot answer for itself.
 *
 * The list is read from the host, which reads it from the authorization seam —
 * so this UI is not a Codex page or a Claude page. It renders whatever
 * `dsh-llm-pi-ai` registered, which is one flow per installed pi-ai provider
 * that ships a login. A provider added upstream appears here with no change to
 * this file.
 *
 * Hand-written in the client module format (`window.__ModuleLoader__.load`),
 * as the runtime format is a plain factory and no bundler is required;
 * `require('react')` resolves through the shell's static module table.
 */
window.__ModuleLoader__.load({
  id: "dsh-subscription-login",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    /** Locale namespace owned by this plugin. */
    const NS = "subscription-login";

    /** Host routes owned by this plugin's host half. */
    const BASE = "/plugins/dsh-subscription-login/";

    /** How long one long-poll parks before the client asks again. */
    const WAIT_MS = 25000;

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      "tab": "订阅登录",
      "title": "订阅登录台",
      "subtitle":
        "把 ChatGPT、Claude、GitHub Copilot、OpenRouter 这类订阅账号接进 DSH。登录由 DSH 自己的授权流程执行，这里只负责把过程和结果摆出来。",
      "loading": "正在读取可登录的账号…",
      "retry": "重试",
      "empty": "这个部署没有注册任何可登录的账号。它需要组合里挂载 pi-ai 适配器（@deepseek-ai/dsh-llm-pi-ai）。",
      "emptyHint": "宿主没有提供授权流程时，这里什么都不会显示，而不是显示一个点不动的按钮。",
      "refresh": "刷新",
      "signedIn": "已登录",
      "signedOut": "未登录",
      "kindGrant": "OAuth 授权",
      "kindKey": "密钥记录",
      "signIn": "登录",
      "signInWith": "用 {method} 登录",
      "signOut": "登出",
      "signOutConfirm": "确认登出 {label}？",
      "signOutHint": "登出只删除本机保存的凭据记录，不会通知签发方。要真正吊销，请到对应服务的账号页操作。",
      "busy": "进行中",
      "attemptTitle": "正在登录 {label}",
      "attemptWaiting": "等待授权流程…",
      "cancelled": "已取消。",
      "authorized": "登录成功，凭据已保存。若模型列表里还没有这个 provider，去「设置 → 模型」把它加为一条路由。",
      "failed": "登录失败：{message}",
      "openPage": "打开授权页面",
      "codeLabel": "一次性代码",
      "copy": "复制",
      "copied": "已复制",
      "answerPlaceholder": "在此粘贴",
      "submit": "提交",
      "selectOption": "请选择",
      "cancel": "取消登录",
      "orphanTitle": "无主的登录凭据",
      "orphanBody":
        "这些记录在 llm-pi-ai 作用域里，但当前没有任何登录流程认领它们——通常是对应的 provider 不再提供，或提供登录的插件已被卸载。留着它们没有害处，但也没用了。",
      "orphanRemove": "删除",
      "scopeTitle": "范围说明",
      "scopeBody":
        "本页只管理 llm-pi-ai/<provider> 这一族凭据记录，其它插件写的记录一律不显示、也不允许在这里删除。",
      "methodLabel": "方式",
      "othersShow": "显示其它 {count} 个提供方（只提供 API 密钥）",
      "othersHide": "收起其它提供方",
      "othersNote":
        "这些 provider 只提供 API 密钥登录，官方「设置 → 模型」页面已经在管它们。列在这里只是让你看到登录台的完整视野，不代表这里更该用它。",
    };

    /** English dictionary, keyed to the same set. */
    const en = {
      "tab": "Subscriptions",
      "title": "Subscription sign-in",
      "subtitle":
        "Bring ChatGPT, Claude, GitHub Copilot and OpenRouter subscriptions into DSH. The sign-in runs on DSH's own authorization flows; this page only shows the process and the result.",
      "loading": "Reading available sign-ins…",
      "retry": "Retry",
      "empty": "This deployment registered no sign-in flows. It needs the pi-ai adapter (@deepseek-ai/dsh-llm-pi-ai) in its composition.",
      "emptyHint": "When the host offers no authorization flows, this page shows nothing rather than a button that cannot work.",
      "refresh": "Refresh",
      "signedIn": "Signed in",
      "signedOut": "Not signed in",
      "kindGrant": "OAuth grant",
      "kindKey": "key record",
      "signIn": "Sign in",
      "signInWith": "Sign in with {method}",
      "signOut": "Sign out",
      "signOutConfirm": "Sign out of {label}?",
      "signOutHint":
        "Signing out deletes the credential record stored on this machine and tells the issuer nothing. To revoke it for real, use that service's own account page.",
      "busy": "in progress",
      "attemptTitle": "Signing in to {label}",
      "attemptWaiting": "Waiting for the flow…",
      "cancelled": "Cancelled.",
      "authorized": "Signed in. The credential is stored. If the provider is not in the model list yet, add it as a route in Settings → Models.",
      "failed": "Sign-in failed: {message}",
      "openPage": "Open the authorization page",
      "codeLabel": "One-time code",
      "copy": "Copy",
      "copied": "Copied",
      "answerPlaceholder": "Paste here",
      "submit": "Submit",
      "selectOption": "Choose",
      "cancel": "Cancel sign-in",
      "orphanTitle": "Unclaimed credential records",
      "orphanBody":
        "These records live in the llm-pi-ai scope, but no registered flow claims them any more — usually the provider stopped shipping a login, or the plugin that offered it was removed. Harmless to keep, useless to keep.",
      "orphanRemove": "Delete",
      "scopeTitle": "What this page touches",
      "scopeBody":
        "Only llm-pi-ai/<provider> records are listed or deletable here. Records written by other plugins are neither shown nor removable from this page.",
      "methodLabel": "Method",
      "othersShow": "Show the other {count} providers (API key only)",
      "othersHide": "Hide the other providers",
      "othersNote":
        "These providers only offer API-key sign-in, and the shipped Settings → Models page already owns them. They are listed for completeness, not because this page is a better place to use them.",
    };

    /** Stylesheet id, so two mounts of this plugin cannot inject it twice. */
    const STYLE_ID = "dsl-styles";

    /** One stylesheet, injected once, using the shell's theme variables. */
    const CSS =
      // Colour is inherited, never assumed. An earlier version fell back to a
      // light grey here, which is near-invisible in a light theme — exactly what
      // a real session saw, with every secondary control washed out. The shell
      // already themes this column correctly; the only job here is not to
      // override it.
      ".dsl_root{box-sizing:border-box;font-size:13px;line-height:20px;color:inherit}" +
      ".dsl_head{margin-bottom:12px}" +
      ".dsl_title{font-size:15px;font-weight:600;margin:0 0 4px}" +
      ".dsl_sub{margin:0;opacity:.82;max-width:64ch}" +
      ".dsl_bar{display:flex;gap:8px;align-items:center;margin:12px 0}" +
      ".dsl_list{display:flex;flex-direction:column;gap:8px}" +
      ".dsl_row{border:1px solid var(--dsh-color-border,rgba(128,128,128,.32));border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      ".dsl_rowTop{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}" +
      ".dsl_label{font-weight:600}" +
      ".dsl_key{opacity:.75;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}" +
      ".dsl_spacer{flex:1 1 auto}" +
      ".dsl_chip{border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid currentColor;opacity:.95}" +
      ".dsl_chipOn{color:#2f9e44}" +
      ".dsl_chipOff{opacity:.72}" +
      ".dsl_chipBusy{color:#b8860b}" +
      ".dsl_actions{display:flex;gap:6px;flex-wrap:wrap}" +
      ".dsl_btn{font:inherit;padding:4px 12px;border-radius:6px;border:1px solid var(--dsh-color-border,rgba(128,128,128,.55));background:transparent;color:inherit;cursor:pointer}" +
      ".dsl_btn:hover:not(:disabled){border-color:currentColor;background:rgba(128,128,128,.12)}" +
      ".dsl_btn:disabled{opacity:.5;cursor:default}" +
      ".dsl_btnPrimary{background:var(--dsh-color-accent,#4c8dff);border-color:transparent;color:#fff;font-weight:500}" +
      // The accent edge is the point: this panel is the only thing on the page
      // that is waiting on the user right now, and it must not read as just
      // another row.
      ".dsl_panel{margin:12px 0;border:1px solid var(--dsh-color-border,rgba(128,128,128,.32));border-left:3px solid var(--dsh-color-accent,#4c8dff);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px}" +
      ".dsl_notice{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
      ".dsl_notice a{color:inherit}" +
      ".dsl_code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;font-weight:600;letter-spacing:.08em;padding:3px 10px;border-radius:6px;border:1px dashed var(--dsh-color-border,rgba(128,128,128,.6))}" +
      ".dsl_form{display:flex;gap:6px}" +
      ".dsl_input{font:inherit;flex:1 1 auto;min-width:0;padding:4px 8px;border-radius:6px;border:1px solid var(--dsh-color-border,rgba(128,128,128,.55));background:transparent;color:inherit}" +
      ".dsl_note{opacity:.82;margin:0;max-width:64ch;overflow-wrap:anywhere}" +
      ".dsl_orphans{margin-top:16px}" +
      ".dsl_others{margin-top:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}" +
      ".dsl_failure{margin:8px 0 0;padding:8px 10px;border-radius:6px;border:1px solid #d1242f;color:#d1242f;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-width:72ch}" +
      ".dsl_err{color:#d1242f;margin:8px 0 0;overflow-wrap:anywhere;white-space:pre-wrap}";

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** One request to the plugin's own host routes. */
    async function api(path, options) {
      const response = await fetch(BASE + path, {
        method: options && options.method ? options.method : "GET",
        headers:
          options && options.body !== undefined
            ? { "content-type": "application/json" }
            : undefined,
        body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options ? options.signal : undefined,
        credentials: "same-origin",
      });
      const text = await response.text();
      const parsed = text === "" ? {} : JSON.parse(text);
      if (!response.ok) {
        const failure = new Error(parsed.message || response.statusText);
        failure.code = parsed.code;
        throw failure;
      }
      return parsed;
    }

    /**
     * The question an attempt is currently parked on, or null.
     *
     * A prompt event is live until the matching `answered` event arrives, so the
     * search runs backwards from the newest prompt rather than assuming the
     * last event is the question.
     */
    function pendingPrompt(events) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.type !== "prompt") continue;
        const answered = events.some(
          (candidate) => candidate.type === "answered" && candidate.promptId === event.promptId,
        );
        if (!answered) return event;
      }
      return null;
    }

    /** Every notice seen so far, oldest first. */
    function noticesOf(events) {
      return events.filter((event) => event.type === "notice").map((event) => event.notice);
    }

    /** Copy text, reporting success rather than assuming the clipboard exists. */
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }

    /**
     * The console.
     *
     * @param props - settings slot props; `t` comes from the locale namespace.
     */
    function LoginConsole(props) {
      const t = props.t;
      const [snapshot, setSnapshot] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [attempt, setAttempt] = react.useState(null);
      const [finished, setFinished] = react.useState(null);
      const [answer, setAnswer] = react.useState("");
      const [copied, setCopied] = react.useState(false);
      const [busy, setBusy] = react.useState(false);
      const [showOthers, setShowOthers] = react.useState(false);
      /** The live sign-in panel, so a started sign-in can be brought into view. */
      const panelRef = react.useRef(null);

      ensureStyles();

      const refresh = react.useCallback(async () => {
        try {
          const next = await api("flows");
          setSnapshot(next);
          setError(null);
        } catch (failure) {
          setError(failure.message);
        }
      }, []);

      react.useEffect(() => {
        refresh();
      }, [refresh]);

      // Follow one attempt to its end. Keyed on the attempt id only: the loop
      // owns its own cursor and accumulates events, so a re-render never
      // restarts it and never re-reads what it has already applied.
      react.useEffect(() => {
        if (attempt === null || attempt.done) return undefined;
        let cancelled = false;
        let cursor = 0;
        const controller = new AbortController();

        const loop = async () => {
          while (!cancelled) {
            let page;
            try {
              page = await api("attempts/" + attempt.id + "?cursor=" + cursor + "&timeout=" + WAIT_MS, {
                signal: controller.signal,
              });
            } catch (failure) {
              if (cancelled) return;
              if (failure.name === "AbortError") return;
              setError(failure.message);
              setAttempt((previous) => (previous === null ? null : { ...previous, done: true }));
              return;
            }
            if (cancelled) return;
            cursor = page.cursor;
            setAttempt((previous) =>
              previous === null || previous.id !== page.attemptId
                ? previous
                : {
                    ...previous,
                    events: previous.events.concat(page.events),
                    cursor: page.cursor,
                    done: page.done,
                    outcome: page.outcome,
                    failure: page.failure,
                  },
            );
            if (page.done) {
              setFinished({ outcome: page.outcome, failure: page.failure, label: attempt.label });
              refresh();
              return;
            }
          }
        };

        loop();
        return () => {
          cancelled = true;
          controller.abort();
        };
      }, [attempt === null ? null : attempt.id]);

      // Bring the panel into view whenever the followed attempt changes. The
      // panel now sits above the list, but the click that started it may have
      // been well below the fold; scrolling it in is what closes that gap.
      // Guarded because a missing ref or a host without scrollIntoView must not
      // turn a started sign-in into an error.
      react.useEffect(() => {
        if (attempt === null) return;
        const node = panelRef.current;
        if (node && typeof node.scrollIntoView === "function") {
          node.scrollIntoView({ block: "nearest" });
        }
      }, [attempt === null ? null : attempt.id]);

      const start = react.useCallback(
        async (key, method) => {
          setBusy(true);
          setError(null);
          setFinished(null);
          setAnswer("");
          try {
            const started = await api("attempts", { method: "POST", body: { key, method } });
            setAttempt({
              id: started.attemptId,
              label: started.label,
              key: started.key,
              events: [],
              cursor: 0,
              done: false,
            });
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        },
        [],
      );

      const submitAnswer = react.useCallback(
        async (event) => {
          event.preventDefault();
          if (attempt === null) return;
          const pending = pendingPrompt(attempt.events);
          if (pending === null) return;
          setBusy(true);
          try {
            await api("attempts/" + attempt.id + "/answers", {
              method: "POST",
              body: { promptId: pending.promptId, value: answer },
            });
            setAnswer("");
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        },
        [attempt, answer],
      );

      const cancelAttempt = react.useCallback(async () => {
        if (attempt === null) return;
        setBusy(true);
        try {
          await api("attempts/" + attempt.id + "/cancel", { method: "POST", body: {} });
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy(false);
        }
      }, [attempt]);

      // Stop a sign-in this page never started: the tab was reloaded, or a
      // second flow was begun over the first. Without this the row is stuck at
      // "in progress" with every button disabled until the host's own deadline
      // expires, which is what a real session hit.
      const cancelByKey = react.useCallback(
        async (flow) => {
          setBusy(true);
          try {
            await api("flows/cancel", { method: "POST", body: { key: flow.key } });
            setFinished(null);
            await refresh();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      const signOut = react.useCallback(
        async (flow) => {
          if (!window.confirm(t("signOutConfirm", { label: flow.label }))) return;
          setBusy(true);
          try {
            await api("logout", { method: "POST", body: { key: flow.key } });
            setFinished(null);
            await refresh();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        },
        [refresh, t],
      );

      const removeOrphan = react.useCallback(
        async (orphan) => {
          if (!window.confirm(t("signOutConfirm", { label: orphan.key }))) return;
          setBusy(true);
          try {
            await api("logout", { method: "POST", body: { key: orphan.key } });
            await refresh();
          } catch (failure) {
            setError(failure.message);
          } finally {
            setBusy(false);
          }
        },
        [refresh, t],
      );

      const children = [];
      // Where the live sign-in panel lands: right under the refresh bar and
      // above the provider list, rather than after it. Below six rows and a
      // disclosure toggle it sat off-screen, and a real user clicked sign-in,
      // saw nothing change, and asked why. The panel is spliced into this slot
      // once it exists.
      let panelSlot = children.length;
      children.push(
        react.createElement(
          "div",
          { className: "dsl_head", key: "head" },
          react.createElement("h3", { className: "dsl_title" }, t("title")),
          react.createElement("p", { className: "dsl_sub" }, t("subtitle")),
        ),
      );

      if (snapshot === null) {
        children.push(
          react.createElement("p", { className: "dsl_note", key: "loading" }, t("loading")),
        );
        panelSlot = children.length;
      } else {
        children.push(
          react.createElement(
            "div",
            { className: "dsl_bar", key: "bar" },
            react.createElement(
              "button",
              { className: "dsl_btn", onClick: refresh, disabled: busy, type: "button" },
              t("refresh"),
            ),
            react.createElement("span", { className: "dsl_spacer" }),
          ),
        );
        panelSlot = children.length;

        if (snapshot.flows.length === 0) {
          children.push(
            react.createElement(
              "div",
              { key: "empty" },
              react.createElement("p", { className: "dsl_note" }, t("empty")),
              react.createElement("p", { className: "dsl_note" }, t("emptyHint")),
            ),
          );
        }

        // A provider earns a place at the top of this page only by offering a
        // subscription sign-in. Everything else here is an API-key record, which
        // the shipped Models page already owns: on a catalog this size the
        // key-only providers outnumber the subscriptions several to one, and
        // flattening them together buries the handful of rows that need a
        // browser round trip.
        const isSubscription = (flow) => flow.methods.some((method) => method.id === "oauth");
        const subscriptions = snapshot.flows.filter(isSubscription);
        const others = snapshot.flows.filter((flow) => !isSubscription(flow));

        const renderRow = (flow) => {
              const chips = [];
              chips.push(
                react.createElement(
                  "span",
                  {
                    key: "state",
                    className: "dsl_chip " + (flow.record.configured ? "dsl_chipOn" : "dsl_chipOff"),
                  },
                  flow.record.configured ? t("signedIn") : t("signedOut"),
                ),
              );
              if (flow.record.kind !== null) {
                chips.push(
                  react.createElement(
                    "span",
                    { key: "kind", className: "dsl_chip dsl_chipOff" },
                    flow.record.kind === "grant" ? t("kindGrant") : t("kindKey"),
                  ),
                );
              }
              if (flow.inFlight) {
                chips.push(
                  react.createElement(
                    "span",
                    { key: "busy", className: "dsl_chip dsl_chipBusy" },
                    t("busy"),
                  ),
                );
              }

              const actions = flow.methods.map((method) =>
                react.createElement(
                  "button",
                  {
                    key: method.id,
                    className: "dsl_btn dsl_btnPrimary",
                    type: "button",
                    disabled: busy || flow.inFlight,
                    onClick: () => start(flow.key, method.id),
                  },
                  flow.methods.length > 1 ? t("signInWith", { method: method.label }) : t("signIn"),
                ),
              );
              if (flow.record.configured) {
                actions.push(
                  react.createElement(
                    "button",
                    {
                      key: "out",
                      className: "dsl_btn",
                      type: "button",
                      disabled: busy,
                      onClick: () => signOut(flow),
                    },
                    t("signOut"),
                  ),
                );
              }
              // A busy row whose attempt this page is not following needs its
              // own way out. When it is the followed attempt, the panel below
              // already offers cancel, so this would be a duplicate.
              if (flow.inFlight && (attempt === null || attempt.key !== flow.key)) {
                actions.push(
                  react.createElement(
                    "button",
                    {
                      key: "cancelByKey",
                      className: "dsl_btn",
                      type: "button",
                      disabled: busy,
                      onClick: () => cancelByKey(flow),
                    },
                    t("cancel"),
                  ),
                );
              }

              return react.createElement(
                "div",
                { className: "dsl_row", key: flow.key },
                react.createElement(
                  "div",
                  { className: "dsl_rowTop" },
                  react.createElement("span", { className: "dsl_label" }, flow.label),
                  react.createElement("span", { className: "dsl_key" }, flow.key),
                  react.createElement("span", { className: "dsl_spacer" }),
                  chips,
                ),
                react.createElement("div", { className: "dsl_actions" }, actions),
              );
        };

        children.push(
          react.createElement("div", { className: "dsl_list", key: "list" }, subscriptions.map(renderRow)),
        );

        if (others.length > 0) {
          children.push(
            react.createElement(
              "div",
              { className: "dsl_others", key: "others" },
              react.createElement(
                "button",
                { className: "dsl_btn", type: "button", onClick: () => setShowOthers(!showOthers) },
                showOthers ? t("othersHide") : t("othersShow", { count: others.length }),
              ),
              showOthers ? react.createElement("p", { className: "dsl_note" }, t("othersNote")) : null,
              showOthers
                ? react.createElement("div", { className: "dsl_list" }, others.map(renderRow))
                : null,
            ),
          );
        }
      }

      if (attempt !== null) {
        const notices = noticesOf(attempt.events);
        const pending = pendingPrompt(attempt.events);
        const panel = [];
        panel.push(
          react.createElement(
            "div",
            { className: "dsl_label", key: "title" },
            t("attemptTitle", { label: attempt.label }),
          ),
        );
        if (notices.length === 0 && pending === null && !attempt.done) {
          panel.push(
            react.createElement("p", { className: "dsl_note", key: "wait" }, t("attemptWaiting")),
          );
        }
        notices.forEach((notice, index) => {
          panel.push(
            react.createElement(
              "div",
              { className: "dsl_notice", key: "n" + index },
              react.createElement("span", null, notice.message),
              notice.url !== undefined
                ? react.createElement(
                    "a",
                    { href: notice.url, target: "_blank", rel: "noreferrer noopener" },
                    t("openPage"),
                  )
                : null,
              notice.code !== undefined
                ? react.createElement(
                    "span",
                    { className: "dsl_code" },
                    notice.code,
                  )
                : null,
              notice.code !== undefined
                ? react.createElement(
                    "button",
                    {
                      className: "dsl_btn",
                      type: "button",
                      onClick: async () => {
                        const ok = await copyText(notice.code);
                        setCopied(ok);
                      },
                    },
                    copied ? t("copied") : t("copy"),
                  )
                : null,
            ),
          );
        });

        if (pending !== null) {
          const question = pending.prompt;
          if (question.kind === "select") {
            panel.push(
              react.createElement("p", { className: "dsl_note", key: "q" }, question.message),
              react.createElement(
                "div",
                { className: "dsl_actions", key: "opts" },
                (question.options || []).map((option) =>
                  react.createElement(
                    "button",
                    {
                      key: option.id,
                      className: "dsl_btn dsl_btnPrimary",
                      type: "button",
                      disabled: busy,
                      title: option.description || undefined,
                      onClick: async () => {
                        setBusy(true);
                        try {
                          await api("attempts/" + attempt.id + "/answers", {
                            method: "POST",
                            body: { promptId: pending.promptId, value: option.id },
                          });
                        } catch (failure) {
                          setError(failure.message);
                        } finally {
                          setBusy(false);
                        }
                      },
                    },
                    option.label,
                  ),
                ),
              ),
            );
          } else {
            panel.push(
              react.createElement("p", { className: "dsl_note", key: "q" }, question.message),
              react.createElement(
                "form",
                { className: "dsl_form", key: "form", onSubmit: submitAnswer },
                react.createElement("input", {
                  className: "dsl_input",
                  type: question.kind === "secret" ? "password" : "text",
                  value: answer,
                  placeholder: question.placeholder || t("answerPlaceholder"),
                  onChange: (event) => setAnswer(event.target.value),
                }),
                react.createElement(
                  "button",
                  { className: "dsl_btn dsl_btnPrimary", type: "submit", disabled: busy },
                  t("submit"),
                ),
              ),
            );
          }
        }

        if (!attempt.done) {
          panel.push(
            react.createElement(
              "div",
              { className: "dsl_actions", key: "cancel" },
              react.createElement(
                "button",
                { className: "dsl_btn", type: "button", disabled: busy, onClick: cancelAttempt },
                t("cancel"),
              ),
            ),
          );
        }

        // Spliced into the slot reserved above, so the panel lands directly
        // under the refresh bar instead of past the whole provider list.
        children.splice(
          panelSlot,
          0,
          react.createElement("div", { className: "dsl_panel", key: "attempt", ref: panelRef }, panel),
        );
      }

      if (finished !== null) {
        // A provider's refusal is the most useful thing this page ever prints —
        // the live GitHub Copilot run returned a structured 403 naming the
        // account and linking the sign-up page — so it gets a diagnostic block
        // of its own rather than muted note styling. The text is passed through
        // verbatim: trimming or paraphrasing it would be inventing an answer.
        children.push(
          react.createElement(
            "p",
            {
              className: finished.failure === undefined ? "dsl_note" : "dsl_failure",
              key: "finished",
            },
            finished.failure !== undefined
              ? t("failed", { message: finished.failure })
              : finished.outcome === "authorized"
                ? t("authorized")
                : t("cancelled"),
          ),
        );
      }

      if (error !== null) {
        children.push(react.createElement("p", { className: "dsl_err", key: "err" }, error));
      }

      if (snapshot !== null && snapshot.orphaned.length > 0) {
        children.push(
          react.createElement(
            "div",
            { className: "dsl_orphans", key: "orphans" },
            react.createElement("h4", { className: "dsl_title" }, t("orphanTitle")),
            react.createElement("p", { className: "dsl_sub" }, t("orphanBody")),
            react.createElement(
              "div",
              { className: "dsl_list" },
              snapshot.orphaned.map((orphan) =>
                react.createElement(
                  "div",
                  { className: "dsl_row", key: orphan.key },
                  react.createElement(
                    "div",
                    { className: "dsl_rowTop" },
                    react.createElement("span", { className: "dsl_key" }, orphan.key),
                    react.createElement("span", { className: "dsl_spacer" }),
                    react.createElement(
                      "button",
                      {
                        className: "dsl_btn",
                        type: "button",
                        disabled: busy,
                        onClick: () => removeOrphan(orphan),
                      },
                      t("orphanRemove"),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      }

      if (snapshot !== null) {
        children.push(
          react.createElement(
            "div",
            { className: "dsl_orphans", key: "scope" },
            react.createElement("h4", { className: "dsl_title" }, t("scopeTitle")),
            react.createElement("p", { className: "dsl_sub" }, t("scopeBody")),
            react.createElement("p", { className: "dsl_note" }, t("signOutHint")),
          ),
        );
      }

      return react.createElement("div", { className: "dsl_root", "data-subscription-login": true }, children);
    }

    /** Client-side services this plugin requires. */
    const inject = ["slots", "locale"];

    /**
     * Register the dictionaries and the settings tab.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "subscription-login: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.slots.inject("settings.plugins.tab", () =>
        ctx.slots.register(
          {
            name: "settings.plugins.tab",
            id: "subscription-login",
            order: 30,
            label: () => t("tab"),
            locale: NS,
          },
          (props) =>
            react.createElement(
              LoginConsole,
              Object.assign({}, props, { t: props.t === undefined ? t : props.t }),
            ),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.LoginConsole = LoginConsole;
    exports.pendingPrompt = pendingPrompt;
    exports.noticesOf = noticesOf;
    return module.exports;
  },
});
