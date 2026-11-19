/**
 * Metrix Companion Service Worker: 后台任务调度与多标签页编排
 */

const PLATFORM_URLS = {
    xiaohongshu: "https://creator.xiaohongshu.com/publish/publish?source=official&target=image",
    zhihu: "https://zhuanlan.zhihu.com/write",
    juejin: "https://juejin.cn/editor/drafts/new?v=2",
    csdn: "https://editor.csdn.net/md/",
    toutiao: "https://mp.toutiao.com/profile_v4/graphic/publish",
    bilibili: "https://member.bilibili.com/york/read-editor",
    feishu: "https://feishu.cn/drive/me/",
    x: "https://x.com/compose/post",
    threads: "https://www.threads.com/"
};

// 内存缓存完整任务（兼容小红书多张高清套卡 DataURL 大载荷传输）
const activeTaskMemoryCache = new Map();

function rememberTaskInMemory(taskId, taskPayload) {
    activeTaskMemoryCache.set(taskId, taskPayload);
    setTimeout(() => {
        activeTaskMemoryCache.delete(taskId);
    }, 30 * 60 * 1000);
}

async function resolveTaskXhsData(taskId) {
    const mem = activeTaskMemoryCache.get(taskId);
    if (mem?.article?.xhs?.imagesDataUrls?.length > 0) {
        return mem.article.xhs;
    }
    const storage = await chrome.storage.local.get("currentTask");
    const cur = storage.currentTask;
    if (cur && cur.taskId === taskId && cur.article?.xhs?.imagesDataUrls?.length > 0) {
        return cur.article.xhs;
    }
    if (cur && cur.taskId === taskId && cur.baseUrl && cur.token) {
        try {
            const resp = await fetch(`${cur.baseUrl}/api/v2/tasks/${taskId}/manifest`, {
                headers: { "X-Matrix-Token": cur.token }
            });
            if (resp.ok) {
                const json = await resp.json();
                if (json?.data?.article) {
                    rememberTaskInMemory(taskId, {
                        baseUrl: cur.baseUrl,
                        taskId,
                        token: cur.token,
                        article: json.data.article,
                        platforms: json.data.platforms,
                        receivedAt: cur.receivedAt
                    });
                    return json.data.article.xhs || null;
                }
            }
        } catch (e) {}
    }
    return cur?.article?.xhs || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "MATRIX_HANDOFF") {
        handleBridgeHandoff(message.handoff)
            .then(() => sendResponse({ ok: true }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    if (message.type === "GET_TASK_XHS_DATA") {
        resolveTaskXhsData(message.taskId)
            .then(xhs => sendResponse({ ok: Boolean(xhs), xhs }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    if (message.type === "DOWNLOAD_XHS_IMAGES") {
        (async () => {
            const images = Array.isArray(message.images) ? message.images.slice(0, 9) : [];
            if (!images.length) {
                sendResponse({ ok: false, error: "无套卡图片可下载" });
                return;
            }
            const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
            let downloaded = 0;
            for (let i = 0; i < images.length; i++) {
                const dataUrl = images[i];
                if (!dataUrl || typeof dataUrl !== "string") continue;
                const ext = /^data:image\/jpeg/i.test(dataUrl) ? "jpg" : "png";
                const filename = `metrix-xhs-${stamp}/${String(i + 1).padStart(2, "0")}.${ext}`;
                await chrome.downloads.download({
                    url: dataUrl,
                    filename,
                    conflictAction: "uniquify",
                    saveAs: false
                });
                downloaded++;
            }
            sendResponse({ ok: downloaded > 0, count: downloaded });
        })().catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    if (message.type === "PLATFORM_DRAFT_STATUS") {
        handlePlatformStatus(message.data);
        return false;
    }

    if (message.type === "HOOK_WINDOW_OPEN") {
        const tabId = sender.tab?.id;
        if (tabId) {
            chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: () => {
                    if (!window.__metrix_open_hooked) {
                        window.__metrix_open_hooked = true;
                        const _realOpen = window.open;
                        window.open = function(url, target, features) {
                            if (url && typeof url === "string" && (url.includes("/docx/") || url.includes("/doc/"))) {
                                location.href = url;
                                return window;
                            }
                            return _realOpen ? _realOpen.call(window, url, target, features) : null;
                        };
                    }
                }
            }).catch(() => {});
        }
        return false;
    }

    if (message.type === "FILL_PLATFORM_EDITOR") {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse({ ok: false, error: "未找到标签页 ID" });
            return true;
        }

        (async () => {
            let xhsPayload = message.xhs || null;
            if (message.platformId === "xiaohongshu" && (!xhsPayload || !xhsPayload.imagesDataUrls?.length)) {
                xhsPayload = await resolveTaskXhsData(message.taskId);
            }

            const res = await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: fillPlatformEditorInPage,
                args: [
                    message.platformId,
                    message.title,
                    message.html,
                    message.markdown,
                    message.assets || [],
                    {
                        digest: message.digest || "",
                        tags: message.tags || [],
                        coverBase64: message.coverBase64 || "",
                        xhs: xhsPayload
                    }
                ]
            });
            const result = res && res[0] ? res[0].result : null;
            sendResponse({ ok: true, result });
        })().catch(err => {
            console.error("[Metrix Worker] executeScript error:", err);
            sendResponse({ ok: false, error: err.message });
        });
        return true;
    }
});

async function handleBridgeHandoff(handoff) {
    const { baseUrl, taskId, token } = handoff;
    console.log(`[Metrix Worker] 收到握手请求: Task ${taskId}`);

    const manifestUrl = `${baseUrl}/api/v2/tasks/${taskId}/manifest`;
    const res = await fetch(manifestUrl, {
        headers: { "X-Matrix-Token": token }
    });

    if (!res.ok) {
        throw new Error(`获取任务清单失败: HTTP ${res.status}`);
    }

    const json = await res.json();
    const taskData = json.data;

    const fullTask = {
        baseUrl,
        taskId,
        token,
        article: taskData.article,
        platforms: taskData.platforms,
        receivedAt: Date.now()
    };
    rememberTaskInMemory(taskId, fullTask);

    // 存储当前活跃任务（遇超限异常自动降级剥离大图数组，改由内存/本地桥接按需拉取）
    try {
        await chrome.storage.local.set({ currentTask: fullTask });
    } catch (storageErr) {
        console.warn("[Metrix Worker] storage.local 写入大图降级为按需拉取:", storageErr);
        const slimArticle = Object.assign({}, taskData.article);
        if (slimArticle.xhs) {
            slimArticle.xhs = Object.assign({}, slimArticle.xhs, { imagesDataUrls: [] });
        }
        await chrome.storage.local.set({
            currentTask: {
                baseUrl,
                taskId,
                token,
                article: slimArticle,
                platforms: taskData.platforms,
                receivedAt: fullTask.receivedAt
            }
        });
    }

    // 依次打开所选平台的编辑页面
    for (const platform of taskData.platforms) {
        const editorUrl = PLATFORM_URLS[platform];
        if (editorUrl) {
            console.log(`[Metrix Worker] 正在打开平台编辑页: ${platform} -> ${editorUrl}`);
            const shouldFocus = taskData.platforms.length === 1 && platform === "xiaohongshu";
            await chrome.tabs.create({ url: editorUrl, active: shouldFocus });
        }
    }
}

async function handlePlatformStatus(data) {
    const { platform, status, draftUrl, error, editor, contentLength } = data;
    console.log(`[Metrix Worker] 收到平台状态回传: ${platform} -> ${status}`);

    const storage = await chrome.storage.local.get("currentTask");
    const currentTask = storage.currentTask;
    if (!currentTask) return;

    try {
        const statusUrl = `${currentTask.baseUrl}/api/v2/tasks/${currentTask.taskId}/status`;
        await fetch(statusUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Matrix-Token": currentTask.token
            },
            body: JSON.stringify({
                platform,
                status,
                draftUrl,
                editor,
                contentLength,
                error
            })
        });
    } catch (e) {
        console.warn("[Metrix Worker] 状态回传思源失败:", e);
    }
}

/**
 * 核心注入函数：在网页 MAIN world 中执行，享有原生 DOM 与页面内部 JS 实例的完整访问权
 */
async function fillPlatformEditorInPage(platformId, title, html, markdown, assets = [], meta = {}) {
    if (!title || !title.trim()) {
        const lines = (markdown || "").split(/\r?\n/);
        for (const l of lines) {
            const s = l.trim().replace(/^#+\s*/, "").replace(/[*_`#]/g, "").trim();
            if (s && !s.startsWith("---") && !s.startsWith(">") && s.length >= 2) {
                title = s.substring(0, 50);
                break;
            }
        }
        if (!title) title = "精选技术笔记";
    }

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const truncateChars = (str, limit) => {
        const chars = Array.from((str || "").trim());
        return chars.length <= limit ? chars.join("") : chars.slice(0, limit).join("");
    };

    function isVisibleControl(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== "none" && st.visibility !== "hidden";
    }

    function setReactControlValue(el, val) {
        if (!el) return false;
        try { el.click?.(); } catch (e) {}
        try { el.focus?.(); } catch (e) {}

        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            const prev = el.value;
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) {
                setter.call(el, val);
            } else {
                el.value = val;
            }
            if (el._valueTracker) {
                try {
                    el._valueTracker.setValue(prev === val ? "" : prev);
                } catch (e) {}
            }
            el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: val }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            return true;
        }

        if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
            try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (e) {}
            const ok = document.execCommand("insertText", false, val);
            if (!ok || !(el.textContent || "").trim()) {
                el.textContent = val;
            }
            el.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: val }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }
        return false;
    }

    function base64ToFile(base64Data, filename, mimeType = "image/png") {
        try {
            const cleanB64 = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
            const byteCharacters = atob(cleanB64);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            return new File([blob], filename, { type: mimeType });
        } catch (e) {
            console.warn("[Metrix] base64ToFile failed:", e);
            return null;
        }
    }

    function fillInputs(selectors, customVal = title) {
        for (let sel of selectors) {
            let el = document.querySelector(sel);
            if (!el || !isVisibleControl(el)) continue;
            if (setReactControlValue(el, customVal)) {
                return el;
            }
        }
        return null;
    }

    // 1. CSDN 博客 (https://editor.csdn.net/md/)
    if (platformId === "csdn") {
        let fillTitle = () => {
            try {
                let d = document.querySelector(".article-bar__title-display");
                d?.click?.();
            } catch (e) {}

            let titleSelectors = [
                "input.article-bar__title--input",
                "input.article-bar__title",
                ".article-bar__title input",
                "input[placeholder*='输入文章标题']",
                "input[placeholder*='文章标题']",
                "input[placeholder*='标题']",
                "#txtTitle"
            ];
            for (let sel of titleSelectors) {
                let el = document.querySelector(sel);
                if (el && isVisibleControl(el)) {
                    setReactControlValue(el, truncateChars(title, 100));
                    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
                    return el;
                }
            }
            return null;
        };

        let triggerSaveDraft = () => {
            let doSave = () => {
                let saveBtn = document.querySelector("button.button-save, button[data-title='保存草稿'], .navigation-bar__button.button-save, button.btn-outline-danger, button.btn-save-draft");
                if (saveBtn && !saveBtn.disabled) {
                    saveBtn.click();
                    saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                } else {
                    let btns = Array.from(document.querySelectorAll("button, [role='button']"));
                    for (let b of btns) {
                        let txt = b.innerText?.trim() || b.textContent?.trim() || b.getAttribute("title") || "";
                        if (txt === "保存草稿" || (txt.includes("保存草稿") && txt.length <= 8) || txt === "存草稿") {
                            b.click();
                            break;
                        }
                    }
                }
                try {
                    let ke = new KeyboardEvent("keydown", { key: "s", code: "KeyS", keyCode: 83, which: 83, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
                    document.dispatchEvent(ke);
                    window.dispatchEvent(ke);
                } catch (e) {}
            };
            setTimeout(doSave, 900);
            setTimeout(doSave, 2200);
            setTimeout(doSave, 3800);
        };

        let stripCsdnWelcomeBoilerplate = (rawText) => {
            if (!rawText) return "";
            const markers = [
                "@[TOC](这里写自定义目录标题)",
                "# 欢迎使用Markdown编辑器",
                "你好！ 这是你第一次使用 **Markdown编辑器**"
            ];
            let cleaned = rawText;
            for (const mk of markers) {
                const idx = cleaned.indexOf(mk);
                if (idx !== -1) {
                    cleaned = cleaned.slice(0, idx).trimEnd();
                }
            }
            return cleaned;
        };

        // 统一规范化换行符 \r\n -> \n，并确保连续 > 引用块的最后一行与后续非 > 正文行之间强制保留至少一个空行 \n\n（防止 CommonMark 懒引用延续）
        let normalizeCsdnMarkdown = (md) => {
            if (!md) return "";
            let text = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            text = text.replace(/(^>[^\n]*)(\n)(?!>|\n)/gm, "$1$2\n");
            return text;
        };
        const cleanMd = normalizeCsdnMarkdown(markdown);

        let findCleditInstance = (el) => {
            try {
                const isCledit = (o) => o && typeof o.setContent === "function" && typeof o.getContent === "function";
                if (isCledit(window.cledit)) return window.cledit;

                const seen = new WeakSet();
                const searchObj = (obj, depth = 0) => {
                    if (!obj || depth > 2 || typeof obj !== "object") return null;
                    if (seen.has(obj)) return null;
                    seen.add(obj);
                    if (isCledit(obj)) return obj;
                    for (const key of Object.keys(obj)) {
                        try {
                            const val = obj[key];
                            if (isCledit(val)) return val;
                            if (depth < 2 && val && typeof val === "object") {
                                const found = searchObj(val, depth + 1);
                                if (found) return found;
                            }
                        } catch (e) {}
                    }
                    return null;
                };

                let cur = el;
                while (cur && cur !== document.documentElement) {
                    const roots = [
                        cur.__vue__,
                        cur.__vueParentComponent?.ctx,
                        cur.__vueParentComponent?.exposed
                    ].filter(Boolean);

                    for (const root of roots) {
                        const found = searchObj(root, 0);
                        if (found) return found;
                    }
                    cur = cur.parentElement;
                }
            } catch (e) {}
            return null;
        };

        let deadline = Date.now() + 15000;
        let cmEl = null;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            fillTitle();
            cmEl = document.querySelector(".CodeMirror");
            editorEl = document.querySelector("pre.editor__inner, .editor__inner[contenteditable='true'], .editor__inner");
            if (cmEl?.CodeMirror || editorEl) break;
            await sleep(250);
        }

        // 等待 CSDN 新建文章异步加载完默认的「# 欢迎使用Markdown编辑器」模板后再清空覆盖，杜绝先粘贴后被追加模板
        if (!location.search.includes("articleId")) {
            const hydrateWait = Date.now() + 1800;
            while (Date.now() < hydrateWait) {
                const curTxt = cmEl?.CodeMirror?.getValue?.() || editorEl?.textContent || "";
                if (curTxt.includes("欢迎使用Markdown编辑器") || curTxt.length > 30) {
                    await sleep(180);
                    break;
                }
                await sleep(150);
            }
        }

        if (cmEl?.CodeMirror && typeof cmEl.CodeMirror.setValue === "function") {
            cmEl.CodeMirror.setValue(cleanMd);
            await sleep(500);
            if ((cmEl.CodeMirror.getValue() || "").includes("欢迎使用Markdown编辑器")) {
                cmEl.CodeMirror.setValue(cleanMd);
            }
            cmEl.CodeMirror.focus?.();
            fillTitle();
            triggerSaveDraft();
            return { ok: true, editor: "codemirror" };
        }

        if (editorEl) {
            const cleditInst = findCleditInstance(editorEl);

            const selectAllCledit = async (waitMs = 220) => {
                editorEl.click?.();
                editorEl.focus();
                try {
                    const sel = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(editorEl);
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch (e) {}
                document.execCommand("selectAll", false, null);
                document.dispatchEvent(new Event("selectionchange"));
                editorEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
                editorEl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
                await sleep(waitMs);
            };

            const pasteToCledit = (text) => {
                const dt = new DataTransfer();
                dt.setData("text/plain", text);
                dt.setData("Text", text);
                editorEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
            };

            const wipeAndWriteCledit = async (text) => {
                if (cleditInst) {
                    try {
                        cleditInst.setContent(text);
                        await sleep(250);
                        if (!(editorEl.textContent || "").includes("欢迎使用Markdown编辑器") && (editorEl.textContent || "").includes(text.slice(0, 15))) {
                            return;
                        }
                    } catch (e) {}
                }

                // 未拿到 cleditInst 或 setContent 失败时，加固走 ClipboardEvent("paste") 主通道
                await selectAllCledit(220);
                pasteToCledit(text);
            };

            await wipeAndWriteCledit(cleanMd);

            // 二次哨兵巡检：等待 550ms 若尾部仍残留 @[TOC](这里写自定义目录标题) 或 # 欢迎使用Markdown编辑器，再做一次覆盖重写
            await sleep(550);
            let afterTxt = editorEl.textContent || "";
            if (afterTxt.includes("欢迎使用Markdown编辑器") || afterTxt.includes("@[TOC](这里写自定义目录标题)")) {
                const pureMd = stripCsdnWelcomeBoilerplate(cleanMd) || cleanMd;
                if (cleditInst) {
                    try { cleditInst.setContent(pureMd); } catch (e) {}
                } else {
                    await selectAllCledit(250);
                    document.execCommand("delete", false, null);
                    await sleep(120);
                    pasteToCledit(pureMd);
                }
            }

            // 校验换行符真实存在，杜绝坍缩
            afterTxt = editorEl.textContent || "";
            if (!afterTxt.includes("\n") && cleanMd.includes("\n")) {
                console.warn("[Metrix-CSDN] Warning: newline missing in editorEl.textContent, retrying paste");
                await selectAllCledit(220);
                pasteToCledit(cleanMd);
            }

            fillTitle();
            triggerSaveDraft();
            return { ok: true, editor: cleditInst ? "cledit-instance" : "csdn-cleditor" };
        }
        return null;
    }

    // 2. 稀土掘金 (https://juejin.cn/editor/drafts/*)
    if (platformId === "juejin") {
        const juejinTitle = truncateChars(title, 80);
        fillInputs([
            "input.title-input",
            "input[placeholder='输入文章标题...']",
            "textarea.title-input",
            "input[placeholder*='文章标题']"
        ], juejinTitle);

        let deadline = Date.now() + 15000;
        let cmEl = null;
        for (; Date.now() < deadline;) {
            cmEl = document.querySelector(".CodeMirror");
            if (cmEl?.CodeMirror && typeof cmEl.CodeMirror.setValue === "function") break;
            await sleep(250);
        }

        if (cmEl?.CodeMirror) {
            cmEl.CodeMirror.setValue(markdown);
            cmEl.CodeMirror.focus?.();
            fillInputs(["input.title-input", "textarea.title-input", "input[placeholder*='文章标题']"], juejinTitle);
            return { ok: true, editor: "codemirror" };
        }

        let ta = document.querySelector(".bytemd-editor textarea, textarea.editor");
        if (ta) {
            setReactControlValue(ta, markdown);
            fillInputs(["input.title-input", "textarea.title-input", "input[placeholder*='文章标题']"], juejinTitle);
            return { ok: true, editor: "textarea" };
        }
        throw new Error("稀土掘金编辑器未找到 CodeMirror 实例");
    }

    // 3. 知乎专栏 (https://zhuanlan.zhihu.com/write)
    if (platformId === "zhihu") {
        try {
            let btns = Array.from(document.querySelectorAll("button, [role='button']"));
            let restoreBtn = btns.find(b => /继续编辑|恢复草稿|确定/.test(b.innerText || b.textContent || ""));
            restoreBtn?.click?.();
        } catch (err) {}

        const zhihuTitle = truncateChars(title, 100);
        const findZhihuTitleEl = () => {
            // 严格匹配真正的 input / textarea / contenteditable 控件，禁止误中 .WriteIndex-titleInput 外层 label/div
            const selectors = [
                ".WriteIndex-titleInput textarea",
                "textarea.WriteIndex-titleInput",
                "textarea[placeholder*='请输入标题']",
                "textarea[placeholder*='标题']",
                "[class*='titleInput'] textarea",
                "[class*='TitleInput'] textarea",
                "input[placeholder*='请输入标题']",
                "input[placeholder*='标题']",
                ".WriteIndex-titleInput [contenteditable='true']",
                "[class*='titleInput'] [contenteditable='true']",
                "[class*='TitleInput'] [contenteditable='true']"
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && isVisibleControl(el)) return el;
            }
            return null;
        };

        // 同时轮询等待标题框与正文编辑器挂载完毕（解决 SPA 初始帧 titleEl 为 null 的问题）
        let deadline = Date.now() + 15000;
        let titleEl = null;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            if (!titleEl) titleEl = findZhihuTitleEl();
            if (!editorEl) {
                editorEl = document.querySelector(
                    ".public-DraftEditor-content[contenteditable='true'], " +
                    ".ProseMirror[contenteditable='true'], " +
                    "div[data-contents='true'], " +
                    "div[contenteditable='true'][role='textbox']"
                );
            }
            if (titleEl && editorEl) break;
            await sleep(220);
        }

        if (!editorEl) {
            editorEl = document.querySelector("div[contenteditable='true']");
        }
        if (!editorEl) throw new Error("知乎页面未找到正文编辑器");

        if (titleEl) {
            setReactControlValue(titleEl, zhihuTitle);
            await sleep(250);
        }

        editorEl.click?.();
        editorEl.focus();
        try {
            let sel = window.getSelection();
            let range = document.createRange();
            range.selectNodeContents(editorEl);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (err) {}

        let dt = new DataTransfer();
        dt.setData("text/html", html);
        dt.setData("text/plain", markdown);
        let pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
        editorEl.dispatchEvent(pasteEvt);

        await sleep(650);

        let currentLen = (editorEl.textContent || "").trim().length;
        if (currentLen < 50) {
            let rootEl = editorEl.closest(".DraftEditor-root") || editorEl.parentElement || editorEl;
            rootEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
            await sleep(650);
        }

        // 粘贴正文会触发知乎新建草稿 (/write -> /p/xxx/edit) 重渲染，必须重新查询最新标题节点并二次锁定标题！
        const ensureZhihuTitle = () => {
            const curTitleEl = findZhihuTitleEl() || titleEl;
            if (!curTitleEl) return;
            const curVal = (curTitleEl.value !== undefined ? curTitleEl.value : curTitleEl.textContent || "").trim();
            if (curVal !== zhihuTitle) {
                setReactControlValue(curTitleEl, zhihuTitle);
            }
        };
        ensureZhihuTitle();
        setTimeout(ensureZhihuTitle, 600);
        setTimeout(ensureZhihuTitle, 1400);

        let triggerZhihuSave = () => {
            try {
                ensureZhihuTitle();
                for (let el of [editorEl, document, window]) {
                    let ke = new KeyboardEvent("keydown", { key: "s", code: "KeyS", keyCode: 83, which: 83, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true });
                    el?.dispatchEvent?.(ke);
                }
                let btns = Array.from(document.querySelectorAll("button, a, [role='button']"));
                for (let b of btns) {
                    let txt = b.innerText?.trim() || b.textContent?.trim() || "";
                    if (txt === "保存草稿" || (txt.includes("保存草稿") && txt.length <= 8) || txt === "保存") {
                        b.click?.();
                        break;
                    }
                }
            } catch (e) {}
        };
        setTimeout(triggerZhihuSave, 800);
        setTimeout(triggerZhihuSave, 2000);

        return { ok: true, editor: "zhihu-editor", length: (editorEl.textContent || "").trim().length };
    }

    // 4. B站专栏 (https://member.bilibili.com/york/read-editor)
    if (platformId === "bilibili") {
        const biliTitle = truncateChars(title, 40);
        const getCookie = (name) => {
            const item = document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
            return item ? item.slice(name.length + 1) : "";
        };
        const biliJct = getCookie("bili_jct");

        const uploadBlobToBfs = async (blob, filename = "image.png") => {
            if (!biliJct || !blob) return null;
            const fd = new FormData();
            fd.append("file_up", blob, filename);
            fd.append("biz", "new_dyn");
            fd.append("category", "daily");
            fd.append("csrf", biliJct);
            const resp = await fetch("https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs", {
                method: "POST",
                body: fd,
                credentials: "include"
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (data.code === 0 && data.data?.image_url) {
                return String(data.data.image_url).replace(/^http:\/\//i, "https://");
            }
            return null;
        };

        // 将正文 HTML 中所有外链/本地图片先上传到 B站官方 BFS 图床 (hdslb.com)，根治「图片粘贴失败，请单独复制图片」
        const doc = new DOMParser().parseFromString(html || "", "text/html");
        const imgNodes = Array.from(doc.querySelectorAll("img"));
        let assetCursor = 0;

        const isBiliAssetUrl = (rawUrl) => {
            try {
                const h = new URL(rawUrl, location.origin).hostname.toLowerCase();
                return h === "hdslb.com" || h.endsWith(".hdslb.com") || h === "bilibili.com" || h.endsWith(".bilibili.com");
            } catch (e) {
                return false;
            }
        };

        for (const imgEl of imgNodes) {
            const src = imgEl.getAttribute("src") || "";
            if (isBiliAssetUrl(src)) continue;

            let fileBlob = null;
            let fileName = "metrix_img.png";

            // 优先匹配思源随任务携带的内存 Base64（0 网络延迟，免疫第三方跨域限制）
            let matchedAsset = assets.find(a =>
                (a.uploadedUrl && a.uploadedUrl === src) ||
                (a.filename && src.includes(a.filename))
            );
            if (!matchedAsset && assetCursor < assets.length) {
                matchedAsset = assets[assetCursor++];
            }

            if (matchedAsset && matchedAsset.base64) {
                fileName = matchedAsset.filename || "metrix_img.png";
                fileBlob = base64ToFile(matchedAsset.base64, fileName, matchedAsset.mimeType || "image/png");
            } else if (src.startsWith("data:image/")) {
                fileBlob = base64ToFile(src, fileName, "image/png");
            } else if (/^https?:\/\//i.test(src)) {
                try {
                    const r = await fetch(src);
                    if (r.ok) fileBlob = await r.blob();
                } catch (e) {}
            }

            if (fileBlob) {
                try {
                    const bfsUrl = await uploadBlobToBfs(fileBlob, fileName);
                    if (bfsUrl) {
                        imgEl.setAttribute("src", bfsUrl);
                        imgEl.removeAttribute("srcset");
                        continue;
                    }
                } catch (e) {
                    console.warn("[Metrix] B站 BFS 单图上传异常:", e);
                }
            }
            // 若未登录或上传失败，移除外部非 hdslb 域名防止触发红色感叹号报错占位
            imgEl.remove();
        }

        const biliHtml = doc.body.innerHTML;
        const normalizeBiliText = (s) => (s || "").replace(/\s+/g, " ").trim();
        const expectedBiliText = normalizeBiliText(doc.body.textContent || "");
        const plainWords = expectedBiliText.length;
        const headProbe = expectedBiliText.slice(0, Math.min(20, expectedBiliText.length));
        const tailProbe = expectedBiliText.length > 36 ? expectedBiliText.slice(-12) : "";
        const expectedImgCount = doc.querySelectorAll("img").length;

        const isBiliContentVerified = (el) => {
            const rawTxt = el?.textContent || window.editor?.getText?.() || "";
            const normTxt = normalizeBiliText(rawTxt);
            const textOk = plainWords === 0 || (
                Boolean(headProbe && normTxt.includes(headProbe)) &&
                (!tailProbe || normTxt.includes(tailProbe)) &&
                normTxt.length >= Math.floor(plainWords * 0.6)
            );
            const actualImgs = el ? el.querySelectorAll("img").length : 0;
            const imgOk = expectedImgCount === 0 || actualImgs >= expectedImgCount;
            return textOk && imgOk && (normTxt.length > 0 || actualImgs > 0);
        };

        if (!biliJct || location.hostname.includes("passport.bilibili.com")) {
            return { ok: false, error: "B站尚未登录，请先在当前 Chrome 登录 B站账号后重试" };
        }

        const titleSelectors = [
            "textarea.title-input__inner",
            "textarea[placeholder*='请输入标题']",
            "textarea[placeholder*='标题']",
            "input[placeholder*='请输入标题']",
            "input[placeholder*='标题']",
            "[placeholder*='请输入标题']",
            ".article-title textarea",
            ".article-title input",
            ".title-container textarea",
            "textarea[maxlength='40']",
            "textarea",
            "input.title-input"
        ];

        // 优先直接注入新版 B站专栏编辑器 (sunflower-read-editor: TipTap window.editor / ProseMirror) 并触发「保存为草稿」生成原生 opus 草稿
        let deadline = Date.now() + 15000;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            if (location.hostname.includes("passport.bilibili.com")) {
                return { ok: false, error: "B站尚未登录，请先在当前 Chrome 登录 B站账号后重试" };
            }
            fillInputs(titleSelectors, biliTitle);
            editorEl = document.querySelector(".editor-container .ProseMirror[contenteditable='true'], .ProseMirror[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true'], .article-content div[contenteditable='true']");
            if (editorEl || (window.editor && window.editor.commands && typeof window.editor.commands.setContent === "function")) {
                break;
            }
            await sleep(250);
        }

        if (editorEl || (window.editor && window.editor.commands && typeof window.editor.commands.setContent === "function")) {
            let usedTiptap = false;

            if (window.editor && window.editor.commands && typeof window.editor.commands.setContent === "function") {
                try {
                    window.editor.commands.setContent(biliHtml, true);
                    window.editor.commands.updateImageCache?.();
                    usedTiptap = true;
                    await sleep(400);
                } catch (tipErr) {
                    console.warn("[Metrix] B站 TipTap setContent 异常，降级 ProseMirror 粘贴:", tipErr);
                    usedTiptap = false;
                }
            }

            if (!editorEl) {
                editorEl = document.querySelector(".editor-container .ProseMirror[contenteditable='true'], .ProseMirror[contenteditable='true'], div[contenteditable='true']");
            }

            if (editorEl && !isBiliContentVerified(editorEl)) {
                editorEl.click?.();
                editorEl.focus();
                try {
                    const sel = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(editorEl);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand("selectAll", false, null);
                    document.execCommand("delete", false, null);
                } catch (err) {}
                await sleep(100);

                const dt = new DataTransfer();
                dt.setData("text/html", biliHtml);
                dt.setData("text/plain", markdown);
                editorEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
                await sleep(450);
                usedTiptap = false;
            }

            fillInputs(titleSelectors, biliTitle);

            const renderedLen = (editorEl?.textContent || window.editor?.getText?.() || "").trim().length;
            if (isBiliContentVerified(editorEl)) {
                // 仅显式点击「保存为草稿」并确认保存成功反馈（绝不点击「发布」按钮，不用快捷键盲兜底）
                let saveBtn = null;
                const btnDeadline = Date.now() + 1500;
                while (Date.now() < btnDeadline) {
                    const btns = Array.from(document.querySelectorAll("button, [role='button']"));
                    saveBtn = btns.find(b => {
                        const txt = (b.innerText || b.textContent || "").trim();
                        return txt === "保存为草稿" || txt === "存草稿" || txt === "保存草稿";
                    });
                    if (saveBtn && !saveBtn.disabled) break;
                    await sleep(150);
                }
                if (!saveBtn || saveBtn.disabled) {
                    return { ok: false, error: "B站正文已填入编辑框，但未找到可用的「保存为草稿」按钮，请手动点击保存", draftUrl: location.href, contentLength: renderedLen };
                }

                const beforeAid = new URLSearchParams(location.search).get("aid") || "";
                saveBtn.click();
                let saveConfirmed = false;
                let saveFailedMsg = "";
                const saveWaitEnd = Date.now() + 3500;
                while (Date.now() < saveWaitEnd) {
                    const tipEl = document.querySelector(".save-tip");
                    const tipText = (tipEl?.textContent || "").trim();
                    const afterAid = new URLSearchParams(location.search).get("aid") || "";
                    if (tipText.includes("失败") || tipEl?.classList?.contains("save-fail")) {
                        saveFailedMsg = tipText || "B站保存草稿返回失败提示";
                        break;
                    }
                    if (tipText.includes("保存成功") || (afterAid && afterAid !== beforeAid)) {
                        saveConfirmed = true;
                        await sleep(250);
                        break;
                    }
                    await sleep(200);
                }
                if (saveFailedMsg || !saveConfirmed) {
                    return {
                        ok: false,
                        error: saveFailedMsg || "B站正文已填入编辑框，但未收到「保存成功」落库确认，请手动点击保存草稿",
                        draftUrl: location.href,
                        contentLength: renderedLen
                    };
                }

                return {
                    ok: true,
                    editor: usedTiptap ? "bilibili-tiptap" : "bilibili-prosemirror",
                    draftUrl: location.href,
                    contentLength: renderedLen
                };
            }
        }

        // 兜底通道：仅当编辑器未挂载或 DOM 写入失败时才走接口保存（使用 x-www-form-urlencoded + draft/view 节点校验）
        try {
            let bannerUrl = "";
            if (meta.coverBase64) {
                const coverFile = base64ToFile(meta.coverBase64, "cover.png", "image/png");
                if (coverFile) {
                    bannerUrl = (await uploadBlobToBfs(coverFile, "cover.png")) || "";
                }
            }
            const formParams = new URLSearchParams();
            formParams.append("title", biliTitle);
            formParams.append("content", biliHtml);
            formParams.append("summary", meta.digest || "");
            formParams.append("banner_url", bannerUrl);
            formParams.append("words", String(plainWords));
            formParams.append("category", "17");
            formParams.append("list_id", "0");
            formParams.append("tid", "0");
            formParams.append("reprint", "0");
            formParams.append("tags", Array.isArray(meta.tags) && meta.tags.length ? meta.tags.join(",") : "技术,人工智能");
            formParams.append("image_urls", "");
            formParams.append("origin_image_urls", "");
            formParams.append("dynamic_intro", meta.digest || "");
            formParams.append("media_id", "0");
            formParams.append("spoiler", "0");
            formParams.append("original", "1");
            formParams.append("top_video_bvid", "");
            formParams.append("csrf", biliJct);

            const draftResp = await fetch("https://api.bilibili.com/x/article/creative/draft/addupdate", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body: formParams.toString(),
                credentials: "include"
            });
            if (draftResp.ok) {
                const draftJson = await draftResp.json();
                if (draftJson.code === 0 && draftJson.data?.aid !== undefined) {
                    const aid = String(draftJson.data.aid);
                    let verifiedNonEmpty = false;
                    try {
                        const viewResp = await fetch(`https://api.bilibili.com/x/dynamic/feed/article/draft/view?article_id=${encodeURIComponent(aid)}`, {
                            credentials: "include"
                        });
                        if (viewResp.ok) {
                            const viewJson = await viewResp.json();
                            const draft = viewJson?.data?.draft;
                            const opusParas = draft?.opus?.content?.paragraphs;
                            const hasOpus = Array.isArray(opusParas) && opusParas.some(p =>
                                (Array.isArray(p?.text?.nodes) && p.text.nodes.some(n => (n?.word?.words || "").trim())) ||
                                p?.pic || p?.code
                            );
                            const legacyText = draft?.content
                                ? normalizeBiliText(new DOMParser().parseFromString(String(draft.content), "text/html").body.textContent || "")
                                : "";
                            const hasLegacyHtml = plainWords === 0 || (Boolean(headProbe && legacyText.includes(headProbe)) && legacyText.length >= Math.floor(plainWords * 0.6));
                            verifiedNonEmpty = hasOpus || hasLegacyHtml;
                        }
                    } catch (e) {}

                    const draftUrl = `https://member.bilibili.com/york/read-editor?aid=${encodeURIComponent(aid)}`;
                    setTimeout(() => { location.replace(draftUrl); }, 120);
                    if (!verifiedNonEmpty && (plainWords > 0 || expectedImgCount > 0)) {
                        return { ok: false, error: `B站接口返回 aid=${aid} 但 draft/view 有效正文节点校验为空`, draftUrl };
                    }
                    return { ok: true, editor: "bilibili-draft-api", draftUrl };
                }
            }
        } catch (apiErr) {
            console.warn("[Metrix] B站草稿兜底 API 异常:", apiErr);
        }

        return { ok: false, error: "B站专栏编辑器未就绪或正文写入失败，请刷新页面后重试" };
    }

    // 5. 飞书云文档 (https://*.feishu.cn/docx/*)
    if (platformId === "feishu") {
        let deadline = Date.now() + 20000;
        let titleEl = null;
        let bodyEditor = null;

        for (; Date.now() < deadline;) {
            titleEl = document.querySelector(
                '.doc-title [contenteditable="true"], ' +
                '[data-placeholder*="无标题"], [data-placeholder*="标题"], ' +
                '[placeholder*="无标题"], [placeholder*="标题"], ' +
                '.title-editor [contenteditable="true"], .title-editor input, .title-editor textarea, ' +
                '.doc-title'
            );

            let editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(el => {
                let rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return false;
                if (titleEl && (el === titleEl || el.contains(titleEl) || titleEl.contains(el))) return false;
                let ph = el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || "";
                if (ph.includes("无标题") || ph.includes("标题")) return false;
                if (el.closest('.assistive-panel') || el.closest('.comments-sidebar')) return false;
                return true;
            });

            if (editables.length > 0) bodyEditor = editables[0];
            if (titleEl && bodyEditor) break;
            await new Promise(res => setTimeout(res, 300));
        }

        // 注入标题
        if (titleEl) {
            if (titleEl.tagName === "INPUT" || titleEl.tagName === "TEXTAREA") {
                titleEl.value = title;
                titleEl.dispatchEvent(new Event("input", { bubbles: true }));
                titleEl.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                titleEl.focus();
                try {
                    let sel = window.getSelection();
                    let range = document.createRange();
                    range.selectNodeContents(titleEl);
                    sel.removeAllRanges();
                    sel.addRange(range);
                } catch (e) {}
                let inserted = document.execCommand("insertText", false, title);
                if (!inserted && !titleEl.textContent.trim()) {
                    titleEl.textContent = title;
                    titleEl.dispatchEvent(new Event("input", { bubbles: true }));
                }
            }
        }

        // 唤起正文块（若初次加载无正文块）
        if (!bodyEditor && titleEl) {
            titleEl.focus();
            titleEl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 }));
            await new Promise(res => setTimeout(res, 500));
            let editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(el => {
                let rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return false;
                if (titleEl && (el === titleEl || el.contains(titleEl) || titleEl.contains(el))) return false;
                return true;
            });
            if (editables.length > 0) bodyEditor = editables[0];
        }

        // 注入正文（剥离首部重复的 H1 标题，避免正文再次出现大标题）
        if (bodyEditor) {
            bodyEditor.focus();
            try {
                let sel = window.getSelection();
                let range = document.createRange();
                range.selectNodeContents(bodyEditor);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (err) {}

            let cleanHtml = (html || "").replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "");
            let cleanMarkdown = (markdown || "").replace(/^\s*#\s+[^\r\n]+[\r\n]+/, "");

            let dt = new DataTransfer();
            dt.setData("text/html", cleanHtml);
            dt.setData("text/plain", cleanMarkdown);
            let pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
            bodyEditor.dispatchEvent(pasteEvt);
            return { ok: true, editor: "feishu-docx" };
        }
    }

    // 6. 海外短内容双平台：X (Twitter) & Threads（智能摘要 + 配图挂载 + 绝不自动点击发布防封号）
    if (platformId === "x" || platformId === "threads") {
        const URL_REGEX = /https?:\/\/[^\s<>()[\]{}"'，。！？；：、]+/g;

        const splitGraphemes = (str) => {
            if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
                const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
                return Array.from(seg.segment(str || ""), s => s.segment);
            }
            return Array.from(str || "");
        };

        const cleanMarkdownForSocial = (rawMd, articleTitle) => {
            let text = (rawMd || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            text = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, "");
            text = text.replace(/!\[[^\]]*\]\([^)]+\)\n*/g, "");
            text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
            text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
            text = text.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1");
            text = text.replace(/^#{1,6}\s+/gm, "");
            text = text.replace(/^>\s?/gm, "");
            text = text.replace(/(\*\*|__|~~|`)/g, "");
            text = text.replace(/\u200b/g, "");

            const normTitle = (articleTitle || "").replace(/\s+/g, " ").trim();
            const lines = text.split("\n").map(l => l.trimEnd());
            const filtered = [];
            for (const line of lines) {
                const t = line.trim();
                if (/^(?:作者|定位)[：:]/.test(t)) continue;
                if (/^💡\s*关注【/.test(t) || /^欢迎在评论区探讨/.test(t)) continue;
                if (filtered.length === 0 && normTitle && t.replace(/\s+/g, " ") === normTitle) continue;
                filtered.push(line.replace(/^文章概览[：:]\s*/, ""));
            }
            return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
        };

        const measureSocialText = (str, weighted) => {
            const s = str || "";
            if (!weighted) return splitGraphemes(s).length;
            const urls = s.match(URL_REGEX) || [];
            const withoutUrls = s.replace(URL_REGEX, "");
            let score = urls.length * 23;
            for (const grapheme of splitGraphemes(withoutUrls)) {
                const cp = grapheme.codePointAt(0) || 0;
                const isSingleAscii = grapheme.length === 1 && cp <= 0x024F;
                score += isSingleAscii ? 1 : 2;
            }
            return score;
        };

        const trimToSocialLimit = (text, maxUnits, weighted) => {
            if (measureSocialText(text, weighted) <= maxUnits) return text;
            const ellipsis = "…";
            const budget = Math.max(10, maxUnits - measureSocialText(ellipsis, weighted));

            // 将 URL 视为不可切分原子 Token，避免截断破坏链接
            const tokens = [];
            let cursor = 0;
            for (const m of text.matchAll(URL_REGEX)) {
                if (m.index > cursor) {
                    tokens.push(...splitGraphemes(text.slice(cursor, m.index)).map(g => ({ text: g, isUrl: false })));
                }
                tokens.push({ text: m[0], isUrl: true });
                cursor = m.index + m[0].length;
            }
            if (cursor < text.length) {
                tokens.push(...splitGraphemes(text.slice(cursor)).map(g => ({ text: g, isUrl: false })));
            }

            let acc = "";
            for (const tok of tokens) {
                const next = acc + tok.text;
                if (measureSocialText(next, weighted) > budget) {
                    // 若是超长 URL 独占且当前内容为空，跳过该 URL（完整全文已备份剪贴板）避免只剩省略号
                    if (tok.isUrl && !acc) continue;
                    break;
                }
                acc = next;
            }
            if (!acc) {
                for (const g of splitGraphemes(text)) {
                    if (measureSocialText(acc + g, weighted) > budget) break;
                    acc += g;
                }
            }

            const urlSpans = [...acc.matchAll(URL_REGEX)].map(m => [m.index, m.index + m[0].length]);
            const minBreakIdx = Math.floor(acc.length * 0.6);
            const safeMatches = [...acc.matchAll(/[。！？.!?\n]/g)].filter(m =>
                !urlSpans.some(([s, e]) => m.index >= s && m.index < e)
            );
            const lastBreak = safeMatches.length ? safeMatches[safeMatches.length - 1].index : -1;
            let out = lastBreak >= minBreakIdx
                ? acc.slice(0, lastBreak + 1).trimEnd() + ellipsis
                : acc.replace(/[\s,，;；:：、\-]+$/u, "").trimEnd() + ellipsis;

            // 二次复验确保即使边界字符略超也能严格落在限额内
            const outTokens = splitGraphemes(out.slice(0, -1));
            while (outTokens.length > 0 && measureSocialText(outTokens.join("") + ellipsis, weighted) > maxUnits) {
                outTokens.pop();
            }
            const finalCore = outTokens.join("").trimEnd();
            return finalCore ? finalCore + ellipsis : ellipsis;
        };

        const buildSocialPostPayload = (articleTitle, rawMarkdown, digest, opts) => {
            const { maxChars, weighted } = opts;
            const cleanTitle = (articleTitle || "").trim();
            const cleanDigest = cleanMarkdownForSocial(digest || "", cleanTitle);
            let cleanBody = cleanMarkdownForSocial(rawMarkdown || "", cleanTitle);
            const fullText = cleanTitle && cleanBody && !cleanBody.startsWith(cleanTitle)
                ? `${cleanTitle}\n\n${cleanBody}`
                : (cleanBody || cleanTitle);

            if (measureSocialText(fullText, weighted) <= maxChars) {
                return {
                    postText: fullText,
                    fullText,
                    truncated: false,
                    charCount: splitGraphemes(fullText).length,
                    weightedCount: measureSocialText(fullText, true)
                };
            }

            // 避免 Threads 拼接摘要后与正文首段「文章概览」重复
            if (cleanDigest && cleanBody) {
                const paras = cleanBody.split(/\n{2,}/);
                const firstPara = (paras[0] || "").trim();
                const overlapPrefix = cleanDigest.slice(0, Math.min(20, cleanDigest.length));
                if (firstPara && overlapPrefix && (firstPara.includes(overlapPrefix) || cleanDigest.includes(firstPara.slice(0, 20)))) {
                    cleanBody = paras.slice(1).join("\n\n").trim();
                }
            }

            let candidate = "";
            if (cleanDigest && cleanTitle) {
                if (!weighted && cleanBody) {
                    candidate = `${cleanTitle}\n\n${cleanDigest}\n\n${cleanBody}`;
                } else {
                    candidate = `${cleanTitle}\n\n${cleanDigest}`;
                }
            } else {
                candidate = fullText;
            }
            const postText = trimToSocialLimit(candidate, maxChars, weighted);
            return {
                postText,
                fullText,
                truncated: true,
                charCount: splitGraphemes(postText).length,
                weightedCount: measureSocialText(postText, true)
            };
        };

        const collectSocialImageFiles = (assetsList, coverB64, maxImages = 4) => {
            const files = [];
            if (Array.isArray(assetsList)) {
                for (let i = 0; i < assetsList.length && files.length < maxImages; i++) {
                    const item = assetsList[i];
                    if (item && item.base64) {
                        const f = base64ToFile(item.base64, item.filename || `metrix_img_${i + 1}.png`, item.mimeType || "image/png");
                        if (f) files.push(f);
                    }
                }
            }
            if (files.length === 0 && coverB64) {
                const coverFile = base64ToFile(coverB64, "metrix_cover.png", "image/png");
                if (coverFile) files.push(coverFile);
            }
            return files;
        };

        const injectPlainTextToRichEditor = async (editorEl, postText) => {
            const normalizeWs = (s) => (s || "").replace(/\s+/g, " ").trim();
            const normExpected = normalizeWs(postText);
            const headProbe = normExpected.slice(0, Math.min(20, normExpected.length));
            const tailProbe = normExpected.length > 36 ? normExpected.slice(-14) : "";
            const isInjectedComplete = () => {
                const cur = normalizeWs(editorEl.textContent);
                return Boolean(headProbe && cur.includes(headProbe) && (!tailProbe || cur.includes(tailProbe)));
            };

            const selectAllEditor = () => {
                editorEl.click?.();
                editorEl.focus?.();
                try {
                    const sel = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(editorEl);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.execCommand("selectAll", false, null);
                } catch (e) {}
            };

            // 若已有残留内容先清空，避免与旧草稿拼接
            if ((editorEl.textContent || "").trim()) {
                selectAllEditor();
                try { document.execCommand("delete", false, null); } catch (e) {}
                await sleep(100);
            } else {
                selectAllEditor();
                await sleep(100);
            }

            // 首选 ClipboardEvent("paste")，原生契合 X Draft.js 与 Threads Lexical
            const pasteDt = new DataTransfer();
            pasteDt.setData("text/plain", postText);
            pasteDt.setData("Text", postText);
            editorEl.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: pasteDt
            }));
            await sleep(350);

            if (!isInjectedComplete()) {
                selectAllEditor();
                try {
                    document.execCommand("insertText", false, postText);
                } catch (e) {}
                await sleep(250);
            }

            if (!isInjectedComplete()) {
                selectAllEditor();
                try {
                    editorEl.dispatchEvent(new InputEvent("beforeinput", {
                        bubbles: true,
                        cancelable: true,
                        inputType: "insertText",
                        data: postText
                    }));
                } catch (e) {}
                await sleep(200);
            }

            return isInjectedComplete();
        };

        const attachMediaFilesToComposer = async (scopeEl, editorEl, mediaFiles, fileInputSelectors, previewSelectors) => {
            if (!mediaFiles || mediaFiles.length === 0) return 0;
            const queryTarget = scopeEl || document;
            const countPreviews = () => {
                const nodes = queryTarget.querySelectorAll(previewSelectors);
                return nodes ? nodes.length : 0;
            };
            const beforeCount = countPreviews();

            let fileInput = null;
            for (const sel of fileInputSelectors) {
                fileInput = queryTarget.querySelector(sel) || (scopeEl === document ? null : document.querySelector(sel));
                if (fileInput) break;
            }

            if (fileInput) {
                try {
                    const dt = new DataTransfer();
                    mediaFiles.forEach(f => dt.items.add(f));
                    fileInput.files = dt.files;
                    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
                    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
                    const deadline = Date.now() + 1800;
                    while (Date.now() < deadline) {
                        const curCount = countPreviews();
                        if (curCount > beforeCount) {
                            return Math.min(curCount - beforeCount, mediaFiles.length);
                        }
                        await sleep(150);
                    }
                } catch (e) {
                    console.warn(`[Metrix-${platformId}] fileInput mount error:`, e);
                }
            }

            // 确认 fileInput 未触发任何新增预览后再走 ClipboardEvent("paste") 降级粘贴首图
            try {
                const imgDt = new DataTransfer();
                imgDt.items.add(mediaFiles[0]);
                editorEl.focus?.();
                editorEl.dispatchEvent(new ClipboardEvent("paste", {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    clipboardData: imgDt
                }));
                const deadline = Date.now() + 1000;
                while (Date.now() < deadline) {
                    const curCount = countPreviews();
                    if (curCount > beforeCount) return 1;
                    await sleep(150);
                }
            } catch (e) {
                console.warn(`[Metrix-${platformId}] image paste mount error:`, e);
            }
            return 0;
        };

        if (platformId === "x") {
            const findXEditor = () => {
                const candidates = [
                    '[data-testid="tweetTextarea_0"][contenteditable="true"]',
                    '[data-testid="tweetTextarea_0"] [contenteditable="true"]',
                    '[data-testid="tweetTextarea_0"] [role="textbox"]',
                    '[data-testid="tweetTextarea_0RichTextInputContainer"] [contenteditable="true"]',
                    'div[role="dialog"] [role="textbox"][contenteditable="true"]',
                    '.public-DraftEditor-content[contenteditable="true"]',
                    '[role="textbox"][contenteditable="true"]'
                ];
                for (const sel of candidates) {
                    const el = document.querySelector(sel);
                    if (el && isVisibleControl(el)) return el;
                }
                return null;
            };

            const isXLoginWall = () => {
                if (location.pathname.includes("/login") || location.pathname.includes("/i/flow/login")) return true;
                return Boolean(document.querySelector('[data-testid="loginButton"], input[autocomplete="username"]'));
            };

            let editorEl = null;
            const startTs = Date.now();
            const deadline = startTs + 15000;
            while (Date.now() < deadline) {
                editorEl = findXEditor();
                if (editorEl) break;
                if (isXLoginWall() && (Date.now() - startTs) > 4000) {
                    return { ok: false, error: "X (Twitter) 尚未登录，请先在当前 Chrome 登录后重试" };
                }
                await sleep(250);
            }

            if (!editorEl) {
                return {
                    ok: false,
                    error: isXLoginWall()
                        ? "X (Twitter) 尚未登录，请先在当前 Chrome 登录后重试"
                        : "未检测到 X 发帖编辑框 (tweetTextarea_0)"
                };
            }

            const payload = buildSocialPostPayload(title, markdown, meta.digest || "", { maxChars: 275, weighted: true });
            const textOk = await injectPlainTextToRichEditor(editorEl, payload.postText);
            if (!textOk) {
                return { ok: false, error: "X 发帖框写入失败，请刷新页面或手动粘贴" };
            }

            const mediaFiles = collectSocialImageFiles(assets, meta.coverBase64, 4);
            const scopeEl = editorEl.closest('div[role="dialog"]') || editorEl.closest('[data-testid="primaryColumn"]') || document;
            const mediaAttached = await attachMediaFilesToComposer(
                scopeEl,
                editorEl,
                mediaFiles,
                [
                    'input[type="file"][data-testid="fileInput"]',
                    'div[role="dialog"] input[type="file"][accept*="image"]',
                    'input[type="file"][accept*="image"]'
                ],
                '[data-testid="attachments"] img, div[role="dialog"] img[src^="blob:"], [data-testid="removeMediaButton"]'
            );

            // 严禁点击 tweetButton / tweetButtonInline，安全停留在待发布确认态
            return {
                ok: true,
                editor: "x-draftjs",
                truncated: payload.truncated,
                charCount: payload.charCount,
                weightedCount: payload.weightedCount,
                mediaAttached,
                fullText: payload.fullText,
                postText: payload.postText
            };
        }

        if (platformId === "threads") {
            const findThreadsEditor = () => {
                const candidates = [
                    'div[role="dialog"] [role="textbox"][contenteditable="true"]',
                    'div[role="dialog"] div[contenteditable="true"]',
                    '[role="textbox"][contenteditable="true"]',
                    'div[contenteditable="true"][data-lexical-editor="true"]'
                ];
                for (const sel of candidates) {
                    const nodes = Array.from(document.querySelectorAll(sel));
                    for (const el of nodes) {
                        if (!isVisibleControl(el)) continue;
                        if (el.closest('[role="search"]')) continue;
                        return el;
                    }
                }
                return null;
            };

            const findThreadsCreateTrigger = () => {
                const ariaSelectors = [
                    '[aria-label="Create"]',
                    '[aria-label="New thread"]',
                    '[aria-label="创建"]',
                    '[aria-label="发帖"]',
                    '[aria-label="新建"]',
                    '[aria-label="新串文"]',
                    '[aria-label="建立"]',
                    'a[href="/create"]',
                    'a[href*="/create"]'
                ];
                for (const sel of ariaSelectors) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const btn = el.closest('button, [role="button"], a') || el;
                    if (isVisibleControl(btn)) return btn;
                }
                for (const svg of Array.from(document.querySelectorAll("svg[aria-label]"))) {
                    const label = (svg.getAttribute("aria-label") || "").trim();
                    if (/^(Create|New thread|创建|发帖|新建|新串文|建立)$/i.test(label)) {
                        const btn = svg.closest('button, [role="button"], a');
                        if (btn && isVisibleControl(btn)) return btn;
                    }
                }
                for (const b of Array.from(document.querySelectorAll('button, [role="button"]'))) {
                    if (!isVisibleControl(b)) continue;
                    const txt = (b.innerText || b.textContent || "").trim();
                    if (/^(What's new\??|Start a thread\.{0,3}|有什么新鲜事[？?]?|分享新鲜事[？?]?|发帖|新串文)$/i.test(txt)) {
                        return b;
                    }
                }
                return null;
            };

            const isThreadsLoginWall = () => {
                if (location.pathname.startsWith("/login")) return true;
                const loginLink = document.querySelector('a[href*="/login"]');
                return Boolean(loginLink && isVisibleControl(loginLink) && !findThreadsCreateTrigger());
            };

            let editorEl = findThreadsEditor();
            let triggerAttempts = 0;
            let lastTriggerAt = 0;
            const startTs = Date.now();
            const deadline = startTs + 15000;
            while (!editorEl && Date.now() < deadline) {
                if (isThreadsLoginWall() && (Date.now() - startTs) > 4000) {
                    return { ok: false, error: "Threads 尚未登录，请先在当前 Chrome 登录后重试" };
                }
                if (triggerAttempts < 2 && Date.now() - lastTriggerAt >= 2500) {
                    const trigger = findThreadsCreateTrigger();
                    if (trigger) {
                        triggerAttempts += 1;
                        lastTriggerAt = Date.now();
                        try {
                            trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                            trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                            trigger.click();
                        } catch (e) {}
                    }
                }
                await sleep(250);
                editorEl = findThreadsEditor();
            }

            if (!editorEl) {
                return {
                    ok: false,
                    error: isThreadsLoginWall()
                        ? "Threads 尚未登录，请先在当前 Chrome 登录后重试"
                        : "未检测到 Threads 发帖框，请确认已登录并点击发帖图标"
                };
            }

            const payload = buildSocialPostPayload(title, markdown, meta.digest || "", { maxChars: 490, weighted: false });
            const textOk = await injectPlainTextToRichEditor(editorEl, payload.postText);
            if (!textOk) {
                return { ok: false, error: "Threads 发帖框写入失败，请手动粘贴" };
            }

            const mediaFiles = collectSocialImageFiles(assets, meta.coverBase64, 4);
            const scopeEl = editorEl.closest('div[role="dialog"]') || editorEl.closest("form") || document;
            const mediaAttached = await attachMediaFilesToComposer(
                scopeEl,
                editorEl,
                mediaFiles,
                [
                    'input[type="file"][accept*="image"]',
                    'input[type="file"]'
                ],
                'img[src^="blob:"], img[src^="data:image/"]'
            );

            // 严禁点击 Post / 发布 按钮，安全停留在待发布确认态
            return {
                ok: true,
                editor: "threads-lexical",
                truncated: payload.truncated,
                charCount: payload.charCount,
                mediaAttached,
                fullText: payload.fullText,
                postText: payload.postText
            };
        }
    }

    // 7. 小红书图文创作平台 (模式 B: human_auto 拟人慢速填充 + 话题自动下拉点选变蓝，绝不点发布)
    if (platformId === "xiaohongshu") {
        // 双随机数叠加模拟正态分布人类操作停顿（严禁固定等间隔 sleep）
        const humanJitterSleep = (minMs, maxMs) => {
            const lo = Math.max(20, Number(minMs) || 300);
            const hi = Math.max(lo + 10, Number(maxMs) || lo + 300);
            const normalApprox = (Math.random() + Math.random()) / 2;
            const delay = Math.round(lo + normalApprox * (hi - lo));
            return new Promise(res => setTimeout(res, delay));
        };

        const xhs = meta.xhs || {};
        if (xhs.mode !== "human_auto") {
            return { ok: false, error: "当前为 safe_assist 零风控模式，禁止自动注入宿主页面" };
        }

        const isXhsLoginWall = () => {
            if (location.pathname.includes("/login")) return true;
            return Boolean(document.querySelector(".sso-login-wrapper") && !document.querySelector('input[type="file"], .creator-tab'));
        };

        if (isXhsLoginWall()) {
            return { ok: false, error: "小红书创作平台尚未登录，请先扫码登录后重试" };
        }

        const findImageFileInput = () => {
            const explicit = Array.from(document.querySelectorAll('input[type="file"][accept*="image"]'));
            if (explicit.length > 0) return explicit[0];
            const allInputs = Array.from(document.querySelectorAll('input[type="file"]'));
            for (const inp of allInputs) {
                const acc = (inp.getAttribute("accept") || "").toLowerCase();
                if (acc.includes("png") || acc.includes("jpg") || acc.includes("jpeg") || acc.includes("webp")) {
                    return inp;
                }
                if (!acc.includes("video") && !acc.includes("mp4") && !acc.includes("mov")) {
                    return inp;
                }
            }
            return null;
        };

        // 1) 若尚未停留在「上传图文」Tab，先拟人点击切换（限定在创作页标签栏内查找可见 Tab）
        const ensureImagePublishTab = async () => {
            const tabCandidates = Array.from(document.querySelectorAll('.creator-tab, [role="tab"], .header-tabs .tab-item, .tabs .tab-item'));
            const imageTab = tabCandidates.find(el => {
                if (!isVisibleControl(el)) return false;
                const t = (el.innerText || el.textContent || "").trim();
                return t === "上传图文" || t === "发布图文";
            });
            if (imageTab && !imageTab.classList.contains("active") && imageTab.getAttribute("aria-selected") !== "true") {
                imageTab.click();
                await humanJitterSleep(1200, 2100);
            }
        };

        const waitDeadline = Date.now() + 15000;
        while (Date.now() < waitDeadline) {
            if (isXhsLoginWall()) {
                return { ok: false, error: "小红书创作平台尚未登录，请先扫码登录后重试" };
            }
            await ensureImagePublishTab();
            if (findImageFileInput()) break;
            await humanJitterSleep(260, 480);
        }

        // 2) 将 1~9 张图片 File[] 一次性挂载进小红书图文上传框
        const rawDataUrls = Array.isArray(xhs.imagesDataUrls) ? xhs.imagesDataUrls.slice(0, 9) : [];
        const files = [];
        for (let i = 0; i < rawDataUrls.length; i++) {
            const dUrl = rawDataUrls[i];
            if (!dUrl || typeof dUrl !== "string") continue;
            const mimeMatch = dUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
            const mime = mimeMatch ? mimeMatch[1] : "image/png";
            const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
            const f = base64ToFile(dUrl, `${String(i + 1).padStart(2, "0")}.${ext}`, mime);
            if (f) files.push(f);
        }

        const fileInput = findImageFileInput();
        if (!fileInput) {
            return { ok: false, error: "未找到小红书图文上传控件，请确认页面停留在「上传图文」Tab" };
        }
        if (files.length > 0) {
            await humanJitterSleep(1400, 2500);
            const dt = new DataTransfer();
            files.forEach(f => dt.items.add(f));
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event("input", { bubbles: true }));
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        }

        const findXhsTitleEl = () => {
            const sels = [
                'input[placeholder*="填写标题"]',
                'input[placeholder*="标题"]',
                '.titleInput input',
                'input.d-text',
                'input.c-input_inner',
                'input[maxlength="20"]'
            ];
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && isVisibleControl(el)) return el;
            }
            return null;
        };

        const findXhsBodyEl = () => {
            const sels = [
                '.tiptap.ProseMirror[contenteditable="true"]',
                '.ProseMirror[contenteditable="true"]',
                '#quillEditor [contenteditable="true"]',
                '.editor-content [contenteditable="true"]',
                '.editor-content',
                'div[contenteditable="true"][role="textbox"]',
                'div[contenteditable="true"]'
            ];
            for (const sel of sels) {
                const el = document.querySelector(sel);
                if (el && isVisibleControl(el) && !el.closest('[class*="title"]')) return el;
            }
            return null;
        };

        // 等待图片上传后标题与正文编辑框挂载出来
        const formDeadline = Date.now() + 20000;
        let titleEl = null;
        let bodyEl = null;
        while (Date.now() < formDeadline) {
            try {
                const guideBtn = document.querySelector(".feature-guide__btn");
                if (guideBtn && isVisibleControl(guideBtn)) guideBtn.click();
            } catch (e) {}
            titleEl = findXhsTitleEl();
            bodyEl = findXhsBodyEl();
            if (titleEl && bodyEl) break;
            await humanJitterSleep(300, 560);
        }

        // 3) 拟人停顿 1.6s ~ 3.2s 后填入 <= 20 字短标题
        const xhsTitle = truncateChars(xhs.title || title, 20);
        if (titleEl && xhsTitle) {
            await humanJitterSleep(1600, 3200);
            setReactControlValue(titleEl, xhsTitle);
        }

        if (!bodyEl) {
            return { ok: false, error: "图片已推入，但未检测到小红书正文编辑器，请手动补充文案" };
        }

        // 4) 拟人停顿 1.5s ~ 3.0s 后向正文编辑器填入纯净正文 bodyWithoutTags
        const xhsBody = String(xhs.bodyWithoutTags || "").trim();
        await humanJitterSleep(1500, 3000);
        bodyEl.click?.();
        bodyEl.focus?.();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(bodyEl);
            sel.removeAllRanges();
            sel.addRange(range);
            if ((bodyEl.textContent || "").trim()) {
                document.execCommand("delete", false, null);
            }
        } catch (e) {}

        if (xhsBody) {
            const pasteDt = new DataTransfer();
            pasteDt.setData("text/plain", xhsBody);
            pasteDt.setData("Text", xhsBody);
            bodyEl.dispatchEvent(new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                composed: true,
                clipboardData: pasteDt
            }));
            await humanJitterSleep(360, 680);

            const probe = xhsBody.replace(/\s+/g, " ").trim().slice(0, 14);
            const curBodyTxt = (bodyEl.textContent || "").replace(/\s+/g, " ").trim();
            if (probe && !curBodyTxt.includes(probe)) {
                try {
                    document.execCommand("insertText", false, xhsBody);
                } catch (e) {
                    bodyEl.textContent = xhsBody;
                }
                bodyEl.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: xhsBody }));
                await humanJitterSleep(260, 520);
            }
        }

        // 5) 对前 5 个 hashtags：拟人停顿后光标置尾插入 " #" + tag，唤醒话题联想并点击第 1 项变蓝
        const hashtags = Array.isArray(xhs.hashtags) ? xhs.hashtags.slice(0, 5) : [];
        let blueTagsCount = 0;

        const moveCaretToEnd = (el) => {
            el.focus?.();
            try {
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (e) {}
        };

        const insertTextAtCaret = (el, txt) => {
            moveCaretToEnd(el);
            let inserted = false;
            try {
                inserted = document.execCommand("insertText", false, txt);
            } catch (e) {}
            if (!inserted) {
                const textNode = document.createTextNode(txt);
                el.appendChild(textNode);
                moveCaretToEnd(el);
            }
            el.dispatchEvent(new InputEvent("input", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: txt
            }));
            const lastChar = txt.slice(-1) || "a";
            el.dispatchEvent(new KeyboardEvent("keyup", { key: lastChar, bubbles: true }));
        };

        const findVisibleTopicCandidate = (tagName) => {
            const topicSelectors = [
                ".publish-topic-item",
                "#creator-editor-topic-container .item",
                '[class*="topic-list"] li',
                '[class*="mention"] li',
                '[class*="topic-container"] [class*="item"]',
                '.tippy-box [class*="topic"] [class*="item"]',
                '.tippy-box li'
            ];
            const visibleItems = [];
            for (const sel of topicSelectors) {
                const nodes = Array.from(document.querySelectorAll(sel));
                for (const n of nodes) {
                    if (!isVisibleControl(n)) continue;
                    if (n.closest("header, nav, .topbar, .sidebar, #metrix-xhs-relay-host")) continue;
                    const txt = (n.innerText || n.textContent || "").trim();
                    if (!txt) continue;
                    visibleItems.push(n);
                }
            }
            if (!visibleItems.length) return null;
            const exact = visibleItems.find(el => (el.innerText || el.textContent || "").includes(tagName));
            return exact || visibleItems[0];
        };

        if (hashtags.length > 0 && xhsBody) {
            insertTextAtCaret(bodyEl, "\n");
        }

        for (let i = 0; i < hashtags.length; i++) {
            const cleanTag = String(hashtags[i] || "").replace(/^#+/, "").trim();
            if (!cleanTag) continue;

            await humanJitterSleep(1400, 2900);
            insertTextAtCaret(bodyEl, " #" + cleanTag);

            let candidate = null;
            const popupDeadline = Date.now() + 2400;
            while (Date.now() < popupDeadline) {
                candidate = findVisibleTopicCandidate(cleanTag);
                if (candidate) break;
                await humanJitterSleep(110, 220);
            }

            if (candidate) {
                const beforeTopicNodes = bodyEl.querySelectorAll('a, [data-type="mention"], [class*="topic"], span[style*="color"]').length;
                await humanJitterSleep(450, 950);
                try {
                    candidate.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                    candidate.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                    candidate.click();
                } catch (e) {}

                await humanJitterSleep(180, 340);
                let stillOpen = Boolean(findVisibleTopicCandidate(cleanTag));
                if (stillOpen) {
                    bodyEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: false, cancelable: true }));
                    bodyEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: false, cancelable: true }));
                    await humanJitterSleep(140, 260);
                    stillOpen = Boolean(findVisibleTopicCandidate(cleanTag));
                }
                const afterTopicNodes = bodyEl.querySelectorAll('a, [data-type="mention"], [class*="topic"], span[style*="color"]').length;
                if (!stillOpen || afterTopicNodes > beforeTopicNodes) {
                    blueTagsCount++;
                }
            } else {
                // 未弹出候选框时不卡死，补空格后继续下一个话题
                insertTextAtCaret(bodyEl, " ");
            }
        }

        // 6) 严禁自动点击最终「发布」按钮！
        return {
            ok: true,
            editor: "xhs-human-auto",
            uploadedCount: files.length,
            titleLength: Array.from(xhsTitle).length,
            blueTagsCount,
            totalTags: hashtags.length
        };
    }

    return null;
}