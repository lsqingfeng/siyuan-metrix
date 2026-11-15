/**
 * Metrix Companion Service Worker: 后台任务调度与多标签页编排
 */

const PLATFORM_URLS = {
    zhihu: "https://zhuanlan.zhihu.com/write",
    juejin: "https://juejin.cn/editor/drafts/new?v=2",
    csdn: "https://editor.csdn.net/md/",
    toutiao: "https://mp.toutiao.com/profile_v4/graphic/publish",
    bilibili: "https://member.bilibili.com/york/read-editor",
    feishu: "https://feishu.cn/drive/me/"
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "MATRIX_HANDOFF") {
        handleBridgeHandoff(message.handoff)
            .then(() => sendResponse({ ok: true }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
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

        chrome.scripting.executeScript({
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
                    coverBase64: message.coverBase64 || ""
                }
            ]
        }).then(res => {
            const result = res && res[0] ? res[0].result : null;
            sendResponse({ ok: true, result });
        }).catch(err => {
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

    // 存储当前活跃任务
    await chrome.storage.local.set({
        currentTask: {
            baseUrl,
            taskId,
            token,
            article: taskData.article,
            platforms: taskData.platforms,
            receivedAt: Date.now()
        }
    });

    // 依次打开所选平台的编辑页面
    for (const platform of taskData.platforms) {
        const editorUrl = PLATFORM_URLS[platform];
        if (editorUrl) {
            console.log(`[Metrix Worker] 正在打开平台编辑页: ${platform} -> ${editorUrl}`);
            await chrome.tabs.create({ url: editorUrl, active: false });
        }
    }
}

async function handlePlatformStatus(data) {
    const { platform, status, draftUrl, error } = data;
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

        for (const imgEl of imgNodes) {
            const src = imgEl.getAttribute("src") || "";
            if (src.includes("hdslb.com") || src.includes("bilibili.com")) continue;

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

        // 优先走 B站官方专栏草稿保存接口（支持标题、正文、摘要、2.35:1 封面与 BFS 图片一次性落库）
        if (biliJct) {
            try {
                let bannerUrl = "";
                if (meta.coverBase64) {
                    const coverFile = base64ToFile(meta.coverBase64, "cover.png", "image/png");
                    if (coverFile) {
                        bannerUrl = (await uploadBlobToBfs(coverFile, "cover.png")) || "";
                    }
                }
                const plainWords = (doc.body.textContent || "").trim().length;
                const draftFd = new FormData();
                draftFd.append("title", biliTitle);
                draftFd.append("content", biliHtml);
                draftFd.append("summary", meta.digest || "");
                draftFd.append("banner_url", bannerUrl);
                draftFd.append("words", String(plainWords));
                draftFd.append("category", "17");
                draftFd.append("list_id", "0");
                draftFd.append("tid", "0");
                draftFd.append("reprint", "0");
                draftFd.append("tags", Array.isArray(meta.tags) && meta.tags.length ? meta.tags.join(",") : "技术,人工智能");
                draftFd.append("image_urls", "");
                draftFd.append("origin_image_urls", "");
                draftFd.append("dynamic_intro", meta.digest || "");
                draftFd.append("media_id", "0");
                draftFd.append("spoiler", "0");
                draftFd.append("original", "1");
                draftFd.append("top_video_bvid", "");
                draftFd.append("csrf", biliJct);

                const draftResp = await fetch("https://api.bilibili.com/x/article/creative/draft/addupdate", {
                    method: "POST",
                    body: draftFd,
                    credentials: "include"
                });
                if (draftResp.ok) {
                    const draftJson = await draftResp.json();
                    if (draftJson.code === 0 && draftJson.data?.aid !== undefined) {
                        const draftUrl = `https://member.bilibili.com/york/read-editor?aid=${encodeURIComponent(String(draftJson.data.aid))}`;
                        setTimeout(() => { location.replace(draftUrl); }, 120);
                        return { ok: true, editor: "bilibili-draft-api", draftUrl };
                    }
                }
            } catch (apiErr) {
                console.warn("[Metrix] B站官方草稿 API 异常，自动切换编辑器粘贴兜底:", apiErr);
            }
        }

        let titleSelectors = [
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

        let deadline = Date.now() + 15000;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            fillInputs(titleSelectors, biliTitle);
            editorEl = document.querySelector(".ProseMirror[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true'], .article-content div[contenteditable='true']");
            if (editorEl) break;
            await sleep(250);
        }

        if (editorEl) {
            editorEl.focus();
            try {
                let sel = window.getSelection();
                let range = document.createRange();
                range.selectNodeContents(editorEl);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (err) {}

            let dt = new DataTransfer();
            dt.setData("text/html", biliHtml);
            dt.setData("text/plain", markdown);
            let pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
            editorEl.dispatchEvent(pasteEvt);
            await sleep(400);
            fillInputs(titleSelectors, biliTitle);
            return { ok: true, editor: "bilibili-prosemirror" };
        }
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

    return null;
}