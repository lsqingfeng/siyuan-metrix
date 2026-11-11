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
            args: [message.platformId, message.title, message.html, message.markdown, message.assets || []]
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
async function fillPlatformEditorInPage(platformId, title, html, markdown, assets = []) {
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

    function base64ToFile(base64Data, filename, mimeType = "image/png") {
        try {
            const byteCharacters = atob(base64Data);
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

    function fillInputs(selectors) {
        for (let sel of selectors) {
            let el = document.querySelector(sel);
            if (!el) continue;
            let proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            let setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) {
                setter.call(el, title);
            } else {
                el.value = title;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            return el;
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
            let titleEl = null;
            for (let sel of titleSelectors) {
                let el = document.querySelector(sel);
                if (el) {
                    titleEl = el;
                    break;
                }
            }
            if (titleEl) {
                titleEl.focus();
                let proto = HTMLInputElement.prototype;
                let setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                if (setter) setter.call(titleEl, title);
                else titleEl.value = title;
                titleEl.dispatchEvent(new Event("input", { bubbles: true }));
                titleEl.dispatchEvent(new Event("change", { bubbles: true }));
                titleEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
                titleEl.dispatchEvent(new Event("blur", { bubbles: true }));
                return titleEl;
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
            setTimeout(doSave, 800);
            setTimeout(doSave, 2000);
            setTimeout(doSave, 3800);
        };

        let deadline = Date.now() + 15000;
        let cmEl = null;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            fillTitle();
            cmEl = document.querySelector(".CodeMirror");
            editorEl = document.querySelector("pre.editor__inner, .editor__inner[contenteditable='true'], .editor__inner");
            if (cmEl?.CodeMirror || editorEl) break;
            await new Promise(res => setTimeout(res, 250));
        }

        if (cmEl?.CodeMirror && typeof cmEl.CodeMirror.setValue === "function") {
            cmEl.CodeMirror.setValue(markdown);
            cmEl.CodeMirror.focus?.();
            fillTitle();
            triggerSaveDraft();
            return { ok: true, editor: "codemirror" };
        }

        if (editorEl) {
            editorEl.focus();
            try {
                let sel = window.getSelection();
                let range = document.createRange();
                range.selectNodeContents(editorEl);
                sel.removeAllRanges();
                sel.addRange(range);
            } catch (e) {}

            let dt = new DataTransfer();
            dt.setData("text/plain", markdown);
            dt.setData("Text", markdown);
            editorEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));

            if (!(editorEl.textContent || "").includes(markdown.slice(0, 20))) {
                document.execCommand("selectAll", false, null);
                document.execCommand("insertText", false, markdown);
            }
            fillTitle();
            triggerSaveDraft();
            return { ok: true, editor: "csdn-cleditor" };
        }
        return null;
    }

    // 2. 稀土掘金 (https://juejin.cn/editor/drafts/*)
    if (platformId === "juejin") {
        fillInputs([
            "input.title-input",
            "input[placeholder='输入文章标题...']",
            "textarea.title-input",
            "input[placeholder*='文章标题']"
        ]);

        let deadline = Date.now() + 15000;
        let cmEl = null;
        for (; Date.now() < deadline;) {
            cmEl = document.querySelector(".CodeMirror");
            if (cmEl?.CodeMirror && typeof cmEl.CodeMirror.setValue === "function") break;
            await new Promise(res => setTimeout(res, 250));
        }

        if (cmEl?.CodeMirror) {
            cmEl.CodeMirror.setValue(markdown);
            cmEl.CodeMirror.focus?.();
            fillInputs(["input.title-input", "textarea.title-input", "input[placeholder*='文章标题']"]);
            return { ok: true, editor: "codemirror" };
        }

        let ta = document.querySelector(".bytemd-editor textarea, textarea.editor");
        if (ta) {
            let proto = HTMLTextAreaElement.prototype;
            let setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(ta, markdown);
            else ta.value = markdown;
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.dispatchEvent(new Event("change", { bubbles: true }));
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

        let titleSelectors = [
            "textarea[placeholder*='请输入标题']",
            "textarea[placeholder*='标题']",
            ".WriteIndex-titleInput textarea",
            "textarea.WriteIndex-titleInput",
            ".WriteIndex-titleInput",
            "input[placeholder*='标题']",
            "textarea"
        ];
        let titleEl = null;
        for (let sel of titleSelectors) {
            let el = document.querySelector(sel);
            if (el) {
                titleEl = el;
                break;
            }
        }
        if (titleEl) {
            titleEl.focus();
            let proto = titleEl instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            let setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(titleEl, title);
            else titleEl.value = title;
            titleEl.dispatchEvent(new Event("input", { bubbles: true }));
            titleEl.dispatchEvent(new Event("change", { bubbles: true }));
            titleEl.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        let deadline = Date.now() + 15000;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            editorEl = document.querySelector(".public-DraftEditor-content[contenteditable='true'], div[data-contents='true'], .ProseMirror[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true']");
            if (editorEl) break;
            await new Promise(res => setTimeout(res, 250));
        }

        if (!editorEl) throw new Error("知乎页面未找到正文编辑器");

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

        await new Promise(res => setTimeout(res, 600));

        let currentLen = (editorEl.textContent || "").trim().length;
        if (currentLen < 50) {
            let rootEl = editorEl.closest(".DraftEditor-root") || editorEl.parentElement || editorEl;
            rootEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
            await new Promise(res => setTimeout(res, 600));
            currentLen = (editorEl.textContent || "").trim().length;
        }

        if (titleEl && !titleEl.value && !titleEl.textContent.trim()) {
            titleEl.focus();
            let proto = titleEl instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            let setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(titleEl, title);
            else titleEl.value = title;
            titleEl.dispatchEvent(new Event("input", { bubbles: true }));
        }

        let triggerZhihuSave = () => {
            try {
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
        triggerZhihuSave();
        setTimeout(triggerZhihuSave, 800);
        setTimeout(triggerZhihuSave, 2000);

        return { ok: true, editor: "zhihu-draftjs", length: (editorEl.textContent || "").trim().length };
    }

    // 4. B站专栏 (https://member.bilibili.com/york/read-editor)
    if (platformId === "bilibili") {
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
        let titleEl = fillInputs(titleSelectors);

        let deadline = Date.now() + 15000;
        let editorEl = null;
        for (; Date.now() < deadline;) {
            editorEl = document.querySelector(".ProseMirror[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true'], .article-content div[contenteditable='true']");
            if (editorEl) break;
            await new Promise(res => setTimeout(res, 250));
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
            dt.setData("text/html", html);
            dt.setData("text/plain", markdown);
            let pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
            editorEl.dispatchEvent(pasteEvt);
            fillInputs(titleSelectors);
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