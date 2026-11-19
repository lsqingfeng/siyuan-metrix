/**
 * Metrix Platform Unified Injector: 针对各大平台草稿箱编辑器的原生注入器
 */

(async function () {
    const href = location.href;
    const hostname = location.hostname;
    console.log("[Metrix Injector] 检测到页面:", href);

    const isXHost = hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com");
    const isThreadsHost = hostname === "threads.com" || hostname.endsWith(".threads.com") || hostname === "threads.net" || hostname.endsWith(".threads.net");
    const isXhsHost = hostname === "creator.xiaohongshu.com" || hostname.endsWith(".xiaohongshu.com");

    // 判断是否为草稿编辑页
    const isEditor = (isXhsHost && (href.includes("/publish") || location.pathname.includes("/login") || location.pathname === "/")) ||
                     href.includes("zhuanlan.zhihu.com/write") ||
                     href.includes("zhuanlan.zhihu.com/p/") ||
                     href.includes("juejin.cn/editor/drafts") ||
                     href.includes("editor.csdn.net/md") ||
                     href.includes("mp.csdn.net/mp_blog/creation/editor") ||
                     href.includes("mp.toutiao.com/profile_v4/graphic/publish") ||
                     href.includes("member.bilibili.com/york/read-editor") ||
                     href.includes("feishu.cn") ||
                     (isXHost && (location.pathname.includes("/compose/post") || location.pathname.includes("/compose/tweet") || location.pathname.includes("/i/flow/login") || location.pathname.startsWith("/login"))) ||
                     (isThreadsHost && (location.pathname === "/" || location.pathname === "" || location.pathname.startsWith("/create") || location.pathname.startsWith("/login")));

    if (!isEditor) {
        return;
    }

    const storage = await chrome.storage.local.get("currentTask");
    const currentTask = storage.currentTask;
    if (!currentTask || !currentTask.article) {
        return;
    }

    // 5分钟内有效，防止旧任务误触发
    if (Date.now() - currentTask.receivedAt > 5 * 60 * 1000) {
        return;
    }

    let pagePlatform = "";
    if (isXhsHost) pagePlatform = "xiaohongshu";
    else if (hostname.includes("zhihu.com")) pagePlatform = "zhihu";
    else if (hostname.includes("juejin.cn")) pagePlatform = "juejin";
    else if (hostname.includes("csdn.net")) pagePlatform = "csdn";
    else if (hostname.includes("toutiao.com")) pagePlatform = "toutiao";
    else if (hostname.includes("bilibili.com")) pagePlatform = "bilibili";
    else if (hostname.includes("feishu.cn")) pagePlatform = "feishu";
    else if (isXHost) pagePlatform = "x";
    else if (isThreadsHost) pagePlatform = "threads";

    if (!pagePlatform) {
        return;
    }
    if (pagePlatform === "x" || pagePlatform === "threads" || pagePlatform === "xiaohongshu") {
        if (!Array.isArray(currentTask.platforms) || !currentTask.platforms.includes(pagePlatform)) {
            return;
        }
    } else if (Array.isArray(currentTask.platforms) && currentTask.platforms.length > 0 && !currentTask.platforms.includes(pagePlatform)) {
        return;
    }

    const article = currentTask.article;

    // B站专栏跳转 ?aid=xxx 时，仅在核实编辑器正文确实非空时跳过，若正文为空则继续执行写入防止空草稿
    if (pagePlatform === "bilibili" && new URLSearchParams(location.search).get("aid")) {
        const doneKey = `metrix_bili_done_${currentTask.taskId}`;
        if (sessionStorage.getItem(doneKey) === "1") {
            const pm = await waitForSelector(".editor-container .ProseMirror[contenteditable='true'], .ProseMirror[contenteditable='true']", 2500);
            if (pm && (pm.textContent || "").trim().length >= 20) {
                showMetrixToast("✅ Metrix: B站专栏图文草稿已保存就绪！", 4000);
                chrome.runtime.sendMessage({
                    type: "PLATFORM_DRAFT_STATUS",
                    data: { platform: "bilibili", status: "success", draftUrl: location.href }
                });
                return;
            }
        }
    }

    // 海外短平台防重复弹窗/覆盖（仅在成功写入后锁定，失败允许刷新重试）
    const socialDoneKey = `metrix_social_done_${currentTask.taskId}_${pagePlatform}`;
    if (pagePlatform === "x" || pagePlatform === "threads") {
        if (sessionStorage.getItem(socialDoneKey) === "1") {
            return;
        }
        if (location.pathname.includes("/login") || location.pathname.includes("/i/flow/login")) {
            const label = pagePlatform === "x" ? "X (Twitter)" : "Threads";
            const errMsg = `请先在当前浏览器登录 ${label} 账号后再重新分发`;
            showMetrixToast(`⚠️ ${errMsg}`, 6000);
            chrome.runtime.sendMessage({
                type: "PLATFORM_DRAFT_STATUS",
                data: { platform: pagePlatform, status: "failed", error: errMsg }
            });
            return;
        }
    }

    // 标题防空保底机制
    if (!article.title || !article.title.trim()) {
        const lines = (article.markdown || "").split(/\r?\n/);
        for (const l of lines) {
            const s = l.trim().replace(/^#+\s*/, "").replace(/[*_`#]/g, "").trim();
            if (s && !s.startsWith("---") && !s.startsWith(">") && s.length >= 2) {
                article.title = s.substring(0, 50);
                break;
            }
        }
        if (!article.title) article.title = "精选技术笔记";
    }

    try {
        if (pagePlatform === "xiaohongshu") {
            await handleXiaohongshuDispatch(currentTask);
        } else if (pagePlatform === "zhihu") {
            await handlePageBridgeOrFallback("zhihu", article, injectZhihuFallback);
        } else if (pagePlatform === "juejin") {
            await handlePageBridgeOrFallback("juejin", article, injectJuejinFallback);
        } else if (pagePlatform === "csdn") {
            await handlePageBridgeOrFallback("csdn", article, injectCSDNFallback);
        } else if (pagePlatform === "toutiao") {
            await injectToutiao(article);
        } else if (pagePlatform === "bilibili") {
            await handlePageBridgeOrFallback("bilibili", article, injectBilibiliFallback);
        } else if (pagePlatform === "feishu") {
            await handleFeishu(article);
        } else if (pagePlatform === "x" || pagePlatform === "threads") {
            await handlePageBridgeOrFallback(pagePlatform, article, () => injectSocialFallback(pagePlatform, article));
        }
    } catch (err) {
        console.error("[Metrix Injector] 注入异常:", err);
    }
})();

/**
 * 优先调用 background 运行在页面 MAIN world 中的原生桥接器，享有页面 JS 实例访问权
 */
async function handlePageBridgeOrFallback(platformId, article, fallbackFn, taskId = "") {
    console.log(`[Metrix Injector] 请求 ${platformId} 原生页面桥接注入...`);
    try {
        const res = await chrome.runtime.sendMessage({
            type: "FILL_PLATFORM_EDITOR",
            platformId,
            taskId,
            title: article.title,
            html: article.html,
            markdown: article.markdown,
            digest: article.digest || "",
            tags: article.tags || [],
            coverBase64: article.coverBase64 || "",
            assets: article.assets || [],
            xhs: article.xhs || null
        });

        if (res && res.ok && res.result) {
            if (res.result.ok === false) {
                const errMsg = res.result.error || `${platformId} 写入失败`;
                console.warn(`[Metrix Injector] ${platformId} 桥接返回失败:`, errMsg);
                showMetrixToast(`⚠️ ${errMsg}`, 6000);
                chrome.runtime.sendMessage({
                    type: "PLATFORM_DRAFT_STATUS",
                    data: { platform: platformId, status: "failed", error: errMsg }
                });
                return;
            }
            if (platformId === "bilibili") {
                const storage = await chrome.storage.local.get("currentTask");
                const tid = storage?.currentTask?.taskId;
                if (tid) sessionStorage.setItem(`metrix_bili_done_${tid}`, "1");
            }
            console.log(`[Metrix Injector] ${platformId} 原生页面桥接注入成功:`, res.result);
            if (platformId === "x" || platformId === "threads") {
                notifySocialInjectionSuccess(platformId, res.result);
            } else if (platformId === "xiaohongshu") {
                if (taskId) sessionStorage.setItem(`metrix_xhs_done_${taskId}`, "1");
                showMetrixToast(
                    `✅ Metrix: 小红书已拟人填充（${res.result.uploadedCount || 0}图 · ${res.result.blueTagsCount || 0}/${res.result.totalTags || 0} 话题变蓝），请核对后手动发布`,
                    6500
                );
            } else if (platformId === "bilibili") {
                showMetrixToast("✅ Metrix: B站专栏正文已注入并触发保存草稿！", 4500);
            }
            chrome.runtime.sendMessage({
                type: "PLATFORM_DRAFT_STATUS",
                data: {
                    platform: platformId,
                    status: "success",
                    draftUrl: res.result.draftUrl || location.href,
                    editor: res.result.editor || "",
                    contentLength: res.result.contentLength ?? res.result.length ?? null
                }
            });
            return;
        }
    } catch (bridgeErr) {
        console.warn(`[Metrix Injector] ${platformId} 页面桥接失败:`, bridgeErr);
    }

    if (typeof fallbackFn === "function") {
        await fallbackFn(article);
    } else {
        const errMsg = `${platformId} 页面桥接未完成，请确认已登录并停留在图文发布页后重试`;
        showMetrixToast(`⚠️ ${errMsg}`, 5500);
        chrome.runtime.sendMessage({
            type: "PLATFORM_DRAFT_STATUS",
            data: { platform: platformId, status: "failed", error: errMsg }
        });
    }
}

function fillTextControl(element, text) {
    if (!element) return;
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
        element.focus();
        const prev = element.value;
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
            setter.call(element, text);
        } else {
            element.value = text;
        }
        if (element._valueTracker) {
            try { element._valueTracker.setValue(prev === text ? "" : prev); } catch (e) {}
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
    } else if (element.isContentEditable || element.getAttribute("contenteditable") === "true") {
        element.focus();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(element);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {}
        const inserted = document.execCommand("insertText", false, text);
        if (!inserted && !element.textContent.trim()) {
            element.textContent = text;
            element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
        }
    }
}

function showMetrixToast(msg, duration = 3000) {
    try {
        let toast = document.getElementById("metrix-toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "metrix-toast";
            toast.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:999999;padding:12px 20px;background:#0f172a;color:#38bdf8;border:1px solid #0284c7;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,0.5);font-size:14px;font-weight:600;pointer-events:none;transition:all 0.3s ease;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;";
            document.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(10px)";
        }, duration);
    } catch (e) {}
}

function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function simulateClick(el) {
    if (!el) return;
    try { el.focus(); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    el.click();
}

async function waitForSelector(selector, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const el = document.querySelector(selector);
        if (el) return el;
        await new Promise(r => setTimeout(r, 200));
    }
    return null;
}

/**
 * 知乎降级注入
 */
async function injectZhihuFallback(article) {
    console.log("[Metrix] 执行知乎本地注入...");
    try {
        const btns = Array.from(document.querySelectorAll("button, [role='button']"));
        const recoverBtn = btns.find(b => /继续编辑|恢复草稿|确定/.test(b.innerText || ""));
        recoverBtn?.click?.();
    } catch (e) {}

    const titleSel = ".WriteIndex-titleInput textarea, textarea.WriteIndex-titleInput, textarea[placeholder*='标题'], [class*='titleInput'] textarea, input[placeholder*='标题']";
    const titleArea = await waitForSelector(titleSel, 8000);
    if (titleArea) {
        fillTextControl(titleArea, article.title);
    }

    await new Promise(r => setTimeout(r, 350));

    const editor = await waitForSelector("div[data-contents='true'], .public-DraftEditor-content[contenteditable='true'], .ProseMirror[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true']", 8000);
    if (editor) {
        editor.focus();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {}

        const dt = new DataTransfer();
        dt.setData("text/html", article.html);
        dt.setData("text/plain", article.markdown);
        editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
    }

    setTimeout(() => {
        try {
            const freshTitle = document.querySelector(titleSel);
            if (freshTitle && !(freshTitle.value || "").trim()) {
                fillTextControl(freshTitle, article.title);
            }
            const ke = new KeyboardEvent("keydown", { key: "s", code: "KeyS", keyCode: 83, which: 83, ctrlKey: true, metaKey: true, bubbles: true });
            document.dispatchEvent(ke);
            const saveBtn = Array.from(document.querySelectorAll("button, a, [role='button']")).find(b => /保存草稿|保存/.test(b.innerText || ""));
            saveBtn?.click?.();
        } catch (e) {}
    }, 1200);

    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: "zhihu", status: "success", draftUrl: location.href }
    });
}

/**
 * 掘金降级注入
 */
async function injectJuejinFallback(article) {
    console.log("[Metrix] 执行掘金本地注入...");
    const titleInput = await waitForSelector("input.title-input, .title-input-wrap input", 8000);
    if (titleInput) {
        fillTextControl(titleInput, article.title);
    }

    await new Promise(r => setTimeout(r, 200));

    const editorArea = await waitForSelector(".bytemd-editor textarea, textarea.editor", 8000);
    if (editorArea) {
        fillTextControl(editorArea, article.markdown);
    }

    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: "juejin", status: "success", draftUrl: location.href }
    });
}

/**
 * CSDN 降级注入
 */
async function injectCSDNFallback(article) {
    console.log("[Metrix] 执行 CSDN 本地注入...");
    try {
        const d = document.querySelector(".article-bar__title-display");
        d?.click?.();
    } catch (e) {}

    const titleInput = await waitForSelector("input.article-bar__title, .article-bar__title input, input[placeholder*='文章标题'], #txtTitle", 8000);
    if (titleInput) {
        fillTextControl(titleInput, article.title);
    }

    await new Promise(r => setTimeout(r, 300));

    const editorArea = await waitForSelector("pre.editor__inner, .editor__inner[contenteditable='true'], .editor__inner, textarea.editor__inner", 8000);
    if (editorArea) {
        await new Promise(r => setTimeout(r, 600));
        editorArea.click?.();
        editorArea.focus();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editorArea);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("selectAll", false, null);
            document.dispatchEvent(new Event("selectionchange"));
        } catch (e) {}
        await new Promise(r => setTimeout(r, 150));
        document.execCommand("delete", false, null);
        await new Promise(r => setTimeout(r, 100));
        if ((editorArea.textContent || "").trim().length > 0) {
            editorArea.textContent = "";
        }
        const inserted = document.execCommand("insertText", false, article.markdown);
        if (!inserted || !(editorArea.textContent || "").includes(article.markdown.slice(0, 15))) {
            const dt = new DataTransfer();
            dt.setData("text/plain", article.markdown);
            editorArea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
        }
    }

    setTimeout(() => {
        try {
            const saveBtn = document.querySelector("button.button-save, button.btn-outline-danger, button[data-title='保存草稿']");
            saveBtn?.click?.();
        } catch (e) {}
    }, 1200);

    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: "csdn", status: "success", draftUrl: location.href }
    });
}

/**
 * 今日头条注入
 */
async function injectToutiao(article) {
    console.log("[Metrix] 正在注入今日头条...");

    const titleInput = await waitForSelector("textarea[placeholder*='文章标题'], input[placeholder*='文章标题']", 8000);
    if (titleInput) {
        fillTextControl(titleInput, article.title);
    }

    await new Promise(r => setTimeout(r, 300));

    const editor = await waitForSelector(".ProseMirror, div[contenteditable='true']", 8000);
    if (editor) {
        editor.focus();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {}

        const dt = new DataTransfer();
        dt.setData("text/html", article.html);
        dt.setData("text/plain", article.markdown);
        editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
    }

    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: "toutiao", status: "success", draftUrl: location.href }
    });
}

/**
 * B站专栏本地降级注入
 */
async function injectBilibiliFallback(article) {
    console.log("[Metrix] 正在执行 B站专栏本地降级注入...");

    const titleArea = await waitForSelector(
        "textarea[placeholder*='请输入标题'], textarea[placeholder*='标题'], input[placeholder*='请输入标题'], input[placeholder*='标题'], [placeholder*='请输入标题'], textarea[maxlength='40'], .article-title textarea, .title-container textarea, textarea",
        8000
    );
    if (titleArea) {
        fillTextControl(titleArea, article.title);
    }

    await new Promise(r => setTimeout(r, 350));

    const editor = await waitForSelector(".ProseMirror[contenteditable='true'], div[contenteditable='true'][role='textbox'], div[contenteditable='true'], .article-content div[contenteditable='true']", 8000);
    if (editor) {
        editor.focus();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {}

        const dt = new DataTransfer();
        dt.setData("text/html", article.html);
        dt.setData("text/plain", article.markdown);
        editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
    }

    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: "bilibili", status: "success", draftUrl: location.href }
    });
}

/**
 * 飞书云文档深度注入
 */
async function handleFeishu(article) {
    console.log("[Metrix] 正在处理飞书注入:", location.href);

    // 1. 如果在飞书云空间主页 (drive/me 或 drive/home)，自动定位“新建”按钮并点击“新建文档”
    if (location.href.includes("drive/me") || location.href.includes("drive/home") || location.href.includes("feishu.cn/drive/")) {
        if (!location.href.includes("/docx/")) {
            await handleFeishuDrive(article);
            return;
        }
    }

    // 2. 如果在具体的 docx 编辑页，执行注入
    if (location.href.includes("/docx/")) {
        await handlePageBridgeOrFallback("feishu", article, injectFeishuFallback);
    }
}

/**
 * 飞书云空间主页驱动：自动查找“新建”按钮与“文档”菜单
 */
async function handleFeishuDrive(article) {
    console.log("[Metrix] 正在处理飞书云空间主页:", location.href);
    showMetrixToast("🚀 Metrix 正在自动创建飞书文档...");

    // 1. 通过后台合规 API 注入 window.open 拦截器，免疫网站 CSP 策略限制
    try {
        chrome.runtime.sendMessage({ type: "HOOK_WINDOW_OPEN" }).catch(() => {});
    } catch (e) {}

    function findFeishuCreateButton() {
        const selectors = [
            '[data-test="create-button"]',
            '[data-test="create-dropdown"]',
            '[data-test="quick-create"]',
            '[data-test="new-create"]',
            'button[aria-label*="新建"]',
            'div[role="button"][aria-label*="新建"]',
            'button[aria-label*="创建"]',
            'div[role="button"][aria-label*="创建"]',
            '[title="新建"]',
            '[title*="新建文档"]',
            '[title*="快速创建"]',
            '.suite-creation-button',
            '.suite-create-btn'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (isElementVisible(el)) return el;
        }

        const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], .ud__button'));
        for (const b of candidates) {
            if (!isElementVisible(b)) continue;
            const txt = (b.innerText || b.textContent || "").trim();
            if (txt === "新建" || txt === "+ 新建" || txt === "新建 +" || /^\+?\s*新建\s*$/.test(txt) || txt === "创建" || txt === "+ 创建") {
                return b;
            }
        }

        const texts = Array.from(document.querySelectorAll('span, div, p'));
        for (const t of texts) {
            if (!isElementVisible(t)) continue;
            const txt = (t.innerText || "").trim();
            if (txt === "新建" || txt === "新建文档" || txt === "+ 新建") {
                if (t.children.length === 0) {
                    return t.closest('button') || t.closest('[role="button"]') || t.closest('.ud__button') || t;
                }
            }
        }

        const plusIcons = Array.from(document.querySelectorAll('svg, [class*="icon-plus"], [class*="Plus"]'));
        for (const icon of plusIcons) {
            const btn = icon.closest('button') || icon.closest('[role="button"]') || icon.closest('.ud__button');
            if (btn && isElementVisible(btn)) {
                return btn;
            }
        }

        return null;
    }

    function findFeishuDocMenuItem() {
        // 必须在下拉菜单容器中搜索，排除侧边栏
        const menuContainers = Array.from(document.querySelectorAll(
            '.ud__menu, [role="menu"], .suite-create-menu, .universe-menu, .ud__dropdown, .ud__popover'
        ));

        for (const menu of menuContainers) {
            if (!isElementVisible(menu)) continue;
            const items = Array.from(menu.querySelectorAll('.ud__menu-item, [role="menuitem"], li, .item, span, div'));
            for (const item of items) {
                if (!isElementVisible(item)) continue;
                const txt = (item.innerText || item.textContent || "").trim();
                if (txt === "文档" || txt === "新建文档" || txt.startsWith("文档\n") || txt.startsWith("新建文档\n") || txt.startsWith("文档 (Docx)")) {
                    return item.closest('.ud__menu-item') || item.closest('[role="menuitem"]') || item;
                }
            }
        }

        const fallbackItems = Array.from(document.querySelectorAll('.ud__menu-item, [role="menuitem"]'));
        for (const item of fallbackItems) {
            if (!isElementVisible(item)) continue;
            const txt = (item.innerText || "").trim();
            if (txt === "文档" || txt === "新建文档" || txt.startsWith("文档\n") || txt.startsWith("新建文档\n")) {
                return item;
            }
        }

        return null;
    }

    let createBtn = null;
    for (let i = 0; i < 35; i++) {
        createBtn = findFeishuCreateButton();
        if (createBtn) break;
        await new Promise(r => setTimeout(r, 200));
    }

    if (!createBtn) {
        console.warn("[Metrix] 未能在当前页面自动定位飞书新建按钮");
        showMetrixToast("⚠️ 未能定位新建按钮，请点击页面「新建文档」", 5000);
        return;
    }

    console.log("[Metrix] 成功定位飞书新建按钮，正在自动点击:", createBtn);
    simulateClick(createBtn);

    let docMenuItem = null;
    for (let j = 0; j < 35; j++) {
        await new Promise(r => setTimeout(r, 150));
        docMenuItem = findFeishuDocMenuItem();
        if (docMenuItem) break;
    }

    if (docMenuItem) {
        console.log("[Metrix] 成功定位新建文档菜单项，正在全自动创建:", docMenuItem);
        showMetrixToast("📄 正在全自动创建并载入新文档...");
        simulateClick(docMenuItem);

        // 如果该节点本身是链接或包含链接，双重保险直接跳转
        const link = docMenuItem.getAttribute("href") || docMenuItem.querySelector("a")?.getAttribute("href");
        if (link && (link.includes("/docx/") || link.includes("/doc/"))) {
            location.href = link;
        }
    } else {
        console.warn("[Metrix] 未能在下拉浮层中自动找到「文档」选项");
        showMetrixToast("⚠️ 请点击下拉菜单中的【文档】", 5000);
    }
}

function showFeishuFloatingAction({ text, onClick }) {
    try {
        let bar = document.getElementById("metrix-feishu-action-bar");
        if (!bar) {
            bar = document.createElement("div");
            bar.id = "metrix-feishu-action-bar";
            bar.style.cssText = "position:fixed;top:16px;right:180px;z-index:999999;display:flex;align-items:center;gap:8px;padding:8px 18px;background:linear-gradient(135deg,#0284c7,#0369a1);color:#ffffff;border-radius:24px;box-shadow:0 8px 24px rgba(2,132,199,0.35);font-size:13px;font-weight:600;cursor:pointer;user-select:none;transition:all 0.2s ease;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;";
            bar.addEventListener("mouseenter", () => bar.style.transform = "scale(1.03)");
            bar.addEventListener("mouseleave", () => bar.style.transform = "scale(1)");
            document.body.appendChild(bar);
        }
        bar.innerHTML = `<span>${text}</span>`;
        bar.onclick = onClick;
    } catch (e) {}
}

/**
 * 飞书云文档本地降级注入
 */
async function injectFeishuFallback(article) {
    console.log("[Metrix] 执行飞书云文档本地注入...", location.href);
    showMetrixToast("✍️ 正在将思源笔记内容写入飞书文档...");

    let titleArea = null;
    let bodyEditor = null;
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
        if (!titleArea) {
            titleArea = document.querySelector(
                '.doc-title [contenteditable="true"], ' +
                '[data-placeholder*="无标题"], [data-placeholder*="标题"], ' +
                '[placeholder*="无标题"], [placeholder*="标题"], ' +
                '.title-editor [contenteditable="true"], .title-editor input, .title-editor textarea, ' +
                '.doc-title'
            );
        }

        const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(el => {
            if (!isElementVisible(el)) return false;
            if (titleArea && (el === titleArea || el.contains(titleArea) || titleArea.contains(el))) return false;
            const ph = el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || "";
            if (ph.includes("无标题") || ph.includes("标题")) return false;
            if (el.closest('.assistive-panel') || el.closest('.comments-sidebar')) return false;
            return true;
        });

        if (editables.length > 0) bodyEditor = editables[0];
        if (titleArea && bodyEditor) break;
        await new Promise(r => setTimeout(r, 300));
    }

    // 1. 注入标题
    if (titleArea) {
        fillTextControl(titleArea, article.title);
    }

    // 2. 若无正文块，尝试在标题处回车唤出正文块
    if (!bodyEditor && titleArea) {
        titleArea.focus();
        titleArea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13 }));
        await new Promise(r => setTimeout(r, 500));
        const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(el => {
            if (!isElementVisible(el)) return false;
            if (titleArea && (el === titleArea || el.contains(titleArea) || titleArea.contains(el))) return false;
            return true;
        });
        if (editables.length > 0) bodyEditor = editables[0];
    }

    // 3. 注入正文
    if (bodyEditor) {
        bodyEditor.focus();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(bodyEditor);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {}

        const cleanHtml = (article.html || "").replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "");
        const cleanMarkdown = (article.markdown || "").replace(/^\s*#\s+[^\r\n]+[\r\n]+/, "");

        const dt = new DataTransfer();
        dt.setData("text/html", cleanHtml);
        dt.setData("text/plain", cleanMarkdown);
        bodyEditor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
    }

    showMetrixToast("✅ 飞书文档草稿写入完成！", 4000);
    showFeishuFloatingAction({
        text: "✅ Metrix: 草稿已写入飞书 (点击重新注入)",
        onClick: () => {
            injectFeishuFallback(article);
        }
    });

    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: "feishu", status: "success", draftUrl: location.href }
    });
}

function copyTextWithFallback(text, container = null) {
    if (!text) return Promise.resolve(false);
    const fallbackExecCopy = () => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
            const mountTarget = container || document.body;
            mountTarget.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            ta.remove();
            return ok;
        } catch (e) {
            return false;
        }
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackExecCopy());
    }
    return Promise.resolve(fallbackExecCopy());
}

function showSocialFloatingBar({ message, fullText, truncated }) {
    try {
        const old = document.getElementById("metrix-social-helper-bar");
        if (old) old.remove();
        const bar = document.createElement("div");
        bar.id = "metrix-social-helper-bar";
        bar.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;align-items:center;gap:10px;max-width:540px;padding:11px 16px;background:#0f172a;color:#e2e8f0;border:1px solid #0284c7;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,0.45);font-size:13px;line-height:1.45;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;";

        const txtSpan = document.createElement("span");
        txtSpan.textContent = message;
        bar.appendChild(txtSpan);

        if (truncated && fullText) {
            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.textContent = "📋 复制完整全文";
            copyBtn.style.cssText = "white-space:nowrap;padding:5px 10px;border:none;border-radius:6px;background:#0284c7;color:#ffffff;font-size:12px;font-weight:600;cursor:pointer;";
            copyBtn.onclick = async () => {
                const ok = await copyTextWithFallback(fullText);
                copyBtn.textContent = ok ? "✔ 已复制全文" : "⚠️ 请手动复制";
                setTimeout(() => { copyBtn.textContent = "📋 复制完整全文"; }, 2200);
            };
            bar.appendChild(copyBtn);
        }

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.title = "关闭提示";
        closeBtn.style.cssText = "border:none;background:transparent;color:#94a3b8;font-size:14px;cursor:pointer;padding:2px 4px;";
        closeBtn.onclick = () => bar.remove();
        bar.appendChild(closeBtn);

        document.body.appendChild(bar);
    } catch (e) {}
}

function notifySocialInjectionSuccess(platformId, result) {
    try {
        chrome.storage.local.get("currentTask").then((st) => {
            const tid = st?.currentTask?.taskId;
            if (tid) sessionStorage.setItem(`metrix_social_done_${tid}_${platformId}`, "1");
        }).catch(() => {});
    } catch (e) {}
    const label = platformId === "x" ? "X (Twitter)" : "Threads";
    const mediaMsg = result.mediaAttached > 0 ? `，已挂 ${result.mediaAttached} 张配图` : "";
    if (result.truncated && result.fullText) {
        copyTextWithFallback(result.fullText).catch(() => {});
        showSocialFloatingBar({
            message: `✅ Metrix: ${label} 摘要已注入 (${result.charCount} 字${mediaMsg})，正文超长已备好全文备份，请核对后手动发布。`,
            fullText: result.fullText,
            truncated: true
        });
    } else {
        showMetrixToast(`✅ Metrix: ${label} 正文已就绪${mediaMsg}，请核对后手动发布`, 5000);
    }
}

async function injectSocialFallback(platformId, article) {
    console.log(`[Metrix] 执行 ${platformId} DOM 降级注入...`);
    const label = platformId === "x" ? "X (Twitter)" : "Threads";
    const editorSel = platformId === "x"
        ? '[data-testid="tweetTextarea_0"][contenteditable="true"], [data-testid="tweetTextarea_0"] [contenteditable="true"], .public-DraftEditor-content[contenteditable="true"]'
        : 'div[role="dialog"] [role="textbox"][contenteditable="true"], [role="textbox"][contenteditable="true"]';
    const editor = await waitForSelector(editorSel, 10000);
    if (!editor) {
        showMetrixToast(`⚠️ 未检测到 ${label} 发帖输入框，请确认已登录并打开编辑框`, 5500);
        chrome.runtime.sendMessage({
            type: "PLATFORM_DRAFT_STATUS",
            data: { platform: platformId, status: "failed", error: `未找到 ${label} 编辑器` }
        });
        return;
    }

    const rawPlain = (article.digest || article.markdown || "").replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/[#*_`>]/g, "").trim();
    const limit = platformId === "x" ? 130 : 480;
    const text = Array.from([article.title, rawPlain].filter(Boolean).join("\n\n")).slice(0, limit).join("");
    const fullText = [article.title, (article.markdown || "").trim()].filter(Boolean).join("\n\n");

    const selectAll = () => {
        editor.click?.();
        editor.focus?.();
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editor);
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand("selectAll", false, null);
        } catch (e) {}
    };

    if ((editor.textContent || "").trim()) {
        selectAll();
        try { document.execCommand("delete", false, null); } catch (e) {}
        await new Promise(r => setTimeout(r, 80));
    } else {
        selectAll();
        await new Promise(r => setTimeout(r, 80));
    }

    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: dt }));
    await new Promise(r => setTimeout(r, 250));

    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const probe = norm(text).slice(0, Math.min(18, norm(text).length));
    if (!probe || !norm(editor.textContent).includes(probe)) {
        selectAll();
        try { document.execCommand("insertText", false, text); } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
    }

    const landed = Boolean(probe && norm(editor.textContent).includes(probe));
    if (!landed) {
        showMetrixToast(`⚠️ ${label} 降级写入未生效，请手动粘贴`, 5500);
        chrome.runtime.sendMessage({
            type: "PLATFORM_DRAFT_STATUS",
            data: { platform: platformId, status: "failed", error: `${label} 编辑器未接受粘贴` }
        });
        return;
    }

    notifySocialInjectionSuccess(platformId, {
        truncated: fullText.length > text.length,
        charCount: Array.from(text).length,
        mediaAttached: 0,
        fullText
    });
    chrome.runtime.sendMessage({
        type: "PLATFORM_DRAFT_STATUS",
        data: { platform: platformId, status: "success", draftUrl: location.href }
    });
}

/**
 * 小红书图文双模分发入口（绝不自动点发布）
 */
async function handleXiaohongshuDispatch(currentTask) {
    const taskId = currentTask.taskId || "";
    const article = currentTask.article || {};

    const isLoginRoute = location.pathname.includes("/login")
        || (Boolean(document.querySelector(".sso-login-wrapper")) && !document.querySelector('input[type="file"], .creator-tab'));
    if (isLoginRoute) {
        chrome.runtime.sendMessage({
            type: "PLATFORM_DRAFT_STATUS",
            data: { platform: "xiaohongshu", status: "failed", error: "请先在当前浏览器扫码登录小红书创作平台后再重新分发" }
        });
        return;
    }

    let xhs = article.xhs ? Object.assign({}, article.xhs) : null;
    if (!xhs || !Array.isArray(xhs.imagesDataUrls) || xhs.imagesDataUrls.length === 0) {
        try {
            const resp = await chrome.runtime.sendMessage({ type: "GET_TASK_XHS_DATA", taskId });
            if (resp && resp.ok && resp.xhs) {
                if (!xhs) {
                    xhs = resp.xhs;
                } else {
                    // 仅补全缺失图片数组，严格保留当前任务显式模式与文案
                    xhs.imagesDataUrls = Array.isArray(resp.xhs.imagesDataUrls) ? resp.xhs.imagesDataUrls : [];
                    if (!xhs.title && resp.xhs.title) xhs.title = resp.xhs.title;
                    if (!xhs.bodyWithoutTags && resp.xhs.bodyWithoutTags) xhs.bodyWithoutTags = resp.xhs.bodyWithoutTags;
                    if ((!Array.isArray(xhs.hashtags) || !xhs.hashtags.length) && Array.isArray(resp.xhs.hashtags)) {
                        xhs.hashtags = resp.xhs.hashtags;
                    }
                }
            }
        } catch (e) {}
    }

    if (!xhs) {
        xhs = {
            mode: "safe_assist",
            title: Array.from((article.title || "思源图文").trim()).slice(0, 20).join(""),
            bodyWithoutTags: (article.markdown || "").trim(),
            hashtags: Array.isArray(article.tags) ? article.tags : [],
            imagesDataUrls: article.coverBase64 ? [`data:image/png;base64,${article.coverBase64}`] : []
        };
    }

    const mode = xhs.mode === "human_auto" ? "human_auto" : "safe_assist";

    // 模式 A：零风控接力模式（绝对不向宿主页面派发任何点击/输入事件，仅挂载隔离 Shadow DOM 接力台）
    if (mode === "safe_assist") {
        const existingHost = document.getElementById("metrix-xhs-relay-host");
        if (existingHost && existingHost.dataset.taskId === taskId) {
            return;
        }
        renderXhsSafeAssistPanel(xhs, taskId);
        if (taskId) sessionStorage.setItem(`metrix_xhs_done_${taskId}`, "1");
        chrome.runtime.sendMessage({
            type: "PLATFORM_DRAFT_STATUS",
            data: {
                platform: "xiaohongshu",
                status: "success",
                editor: "xhs-safe-assist",
                draftUrl: location.href
            }
        });
        return;
    }

    // 模式 B：拟人慢速填充模式（防止同一 taskId 重复执行）
    if (taskId && (sessionStorage.getItem(`metrix_xhs_done_${taskId}`) === "1" || window.__metrix_xhs_running_task === taskId)) {
        return;
    }
    window.__metrix_xhs_running_task = taskId;
    try {
        await handlePageBridgeOrFallback("xiaohongshu", { ...article, xhs }, null, taskId);
    } finally {
        if (window.__metrix_xhs_running_task === taskId) {
            window.__metrix_xhs_running_task = "";
        }
    }
}

/**
 * 在右上角挂载隔离 Shadow DOM 的小红书零风控接力悬浮台
 * 所有操作均发生在 Shadow DOM 内部，绝不触发任何宿主页面的合成事件
 */
function renderXhsSafeAssistPanel(xhs, taskId) {
    const oldHost = document.querySelector('[data-metrix-relay="1"]');
    if (oldHost) oldHost.remove();

    const host = document.createElement("div");
    host.id = "metrix-xhs-relay-host";
    host.dataset.metrixRelay = "1";
    host.dataset.taskId = taskId || "";
    host.style.cssText = "all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;";

    // 彻底隔离面板内键鼠组合事件，避免触发宿主页面的快捷键
    ["keydown", "keyup", "keypress", "input", "paste"].forEach(evtType => {
        host.addEventListener(evtType, (ev) => ev.stopPropagation());
    });

    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
        .panel {
            width: 372px;
            max-height: calc(100vh - 32px);
            display: flex;
            flex-direction: column;
            background: rgba(15, 23, 42, 0.96);
            color: #f8fafc;
            border: 1px solid rgba(255, 36, 66, 0.45);
            border-radius: 16px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.48);
            backdrop-filter: blur(14px);
            overflow: hidden;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 14px;
            background: linear-gradient(135deg, rgba(255, 36, 66, 0.22), rgba(15, 23, 42, 0.95));
            border-bottom: 1px solid rgba(148, 163, 184, 0.16);
        }
        .header-left { display: flex; align-items: center; gap: 8px; }
        .badge {
            font-size: 11px;
            font-weight: 700;
            padding: 2px 7px;
            border-radius: 999px;
            background: rgba(34, 197, 94, 0.18);
            color: #4ade80;
            border: 1px solid rgba(74, 222, 128, 0.35);
        }
        .title-txt { font-size: 13.5px; font-weight: 700; color: #ffffff; }
        .header-btns { display: flex; align-items: center; gap: 6px; }
        .icon-btn {
            border: 1px solid rgba(148, 163, 184, 0.25);
            background: rgba(30, 41, 59, 0.8);
            color: #cbd5e1;
            border-radius: 6px;
            font-size: 12px;
            padding: 3px 8px;
            cursor: pointer;
        }
        .icon-btn:hover { background: rgba(51, 65, 85, 0.95); color: #ffffff; }
        .body {
            padding: 12px 14px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .card {
            background: rgba(30, 41, 59, 0.65);
            border: 1px solid rgba(148, 163, 184, 0.16);
            border-radius: 10px;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .card-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
            color: #94a3b8;
            font-weight: 600;
        }
        .thumb-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
            max-height: 210px;
            overflow-y: auto;
        }
        .thumb-wrap {
            position: relative;
            aspect-ratio: 3 / 4;
            border-radius: 6px;
            overflow: hidden;
            background: #020617;
            border: 1px solid rgba(148, 163, 184, 0.22);
        }
        .thumb-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .thumb-idx {
            position: absolute;
            top: 4px;
            left: 4px;
            background: rgba(2, 6, 23, 0.78);
            color: #f8fafc;
            font-size: 10px;
            font-weight: 700;
            padding: 1px 5px;
            border-radius: 4px;
        }
        .btn-primary {
            width: 100%;
            border: none;
            border-radius: 8px;
            padding: 9px 12px;
            background: linear-gradient(135deg, #ff2442, #e11d48);
            color: #ffffff;
            font-size: 12.5px;
            font-weight: 700;
            cursor: pointer;
            transition: opacity 0.15s;
        }
        .btn-primary:hover { opacity: 0.92; }
        .btn-copy {
            width: 100%;
            border: 1px solid rgba(56, 189, 248, 0.4);
            border-radius: 8px;
            padding: 8px 10px;
            background: rgba(2, 132, 199, 0.18);
            color: #38bdf8;
            font-size: 12.5px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
        }
        .btn-copy:hover { background: rgba(2, 132, 199, 0.3); color: #ffffff; }
        .preview-box {
            font-size: 12px;
            line-height: 1.5;
            color: #e2e8f0;
            background: rgba(15, 23, 42, 0.72);
            border-radius: 6px;
            padding: 7px 9px;
            max-height: 82px;
            overflow-y: auto;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .tags-wrap {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .tag-pill {
            border: 1px solid rgba(56, 189, 248, 0.45);
            background: rgba(56, 189, 248, 0.12);
            color: #7dd3fc;
            border-radius: 999px;
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
        }
        .tag-pill:hover { background: rgba(56, 189, 248, 0.25); color: #ffffff; }
        .tag-pill.copied {
            border-color: rgba(74, 222, 128, 0.6);
            background: rgba(34, 197, 94, 0.2);
            color: #4ade80;
        }
        .hint {
            font-size: 11.5px;
            line-height: 1.5;
            color: #fbbf24;
            background: rgba(245, 158, 11, 0.1);
            border: 1px solid rgba(245, 158, 11, 0.25);
            border-radius: 6px;
            padding: 6px 8px;
        }
        .status-msg { font-size: 11.5px; color: #4ade80; min-height: 14px; }
    `;
    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";

    // Header
    const header = document.createElement("div");
    header.className = "header";
    const hLeft = document.createElement("div");
    hLeft.className = "header-left";
    const titleSpan = document.createElement("span");
    titleSpan.className = "title-txt";
    titleSpan.textContent = "📕 Metrix 接力台";
    const safeBadge = document.createElement("span");
    safeBadge.className = "badge";
    safeBadge.textContent = "🛡️ 0风控";
    hLeft.appendChild(titleSpan);
    hLeft.appendChild(safeBadge);

    const hBtns = document.createElement("div");
    hBtns.className = "header-btns";
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "icon-btn";
    toggleBtn.textContent = "收起";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "icon-btn";
    closeBtn.textContent = "✕";
    hBtns.appendChild(toggleBtn);
    hBtns.appendChild(closeBtn);
    header.appendChild(hLeft);
    header.appendChild(hBtns);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "body";

    toggleBtn.onclick = (ev) => {
        ev.stopPropagation();
        const collapsed = body.style.display === "none";
        body.style.display = collapsed ? "flex" : "none";
        toggleBtn.textContent = collapsed ? "收起" : "展开";
    };
    closeBtn.onclick = (ev) => {
        ev.stopPropagation();
        host.remove();
    };

    // 1. 套卡图片缩略图网格 + 一键下载
    const images = Array.isArray(xhs.imagesDataUrls) ? xhs.imagesDataUrls.slice(0, 9) : [];
    const imgCard = document.createElement("div");
    imgCard.className = "card";
    const imgHead = document.createElement("div");
    imgHead.className = "card-head";
    const imgLabel = document.createElement("span");
    imgLabel.textContent = `🖼️ 套卡图片 (${images.length} 张)`;
    const imgHint = document.createElement("span");
    imgHint.textContent = "下载后拖入左侧上传框";
    imgHead.appendChild(imgLabel);
    imgHead.appendChild(imgHint);
    imgCard.appendChild(imgHead);

    if (images.length > 0) {
        const grid = document.createElement("div");
        grid.className = "thumb-grid";
        images.forEach((srcUrl, idx) => {
            const wrap = document.createElement("div");
            wrap.className = "thumb-wrap";
            const img = document.createElement("img");
            img.src = srcUrl;
            img.alt = `card_${idx + 1}`;
            const badge = document.createElement("span");
            badge.className = "thumb-idx";
            badge.textContent = String(idx + 1).padStart(2, "0");
            wrap.appendChild(img);
            wrap.appendChild(badge);
            grid.appendChild(wrap);
        });
        imgCard.appendChild(grid);
    }

    const dlBtn = document.createElement("button");
    dlBtn.type = "button";
    dlBtn.className = "btn-primary";
    dlBtn.textContent = "📥 一键下载全部套卡图片";
    const dlStatus = document.createElement("div");
    dlStatus.className = "status-msg";

    dlBtn.onclick = async (ev) => {
        ev.stopPropagation();
        if (!images.length) {
            dlStatus.textContent = "⚠️ 当前笔记暂无可下载图片";
            return;
        }
        dlBtn.disabled = true;
        dlBtn.textContent = `⏳ 正在保存 ${images.length} 张图片...`;
        let ok = false;
        try {
            const res = await chrome.runtime.sendMessage({ type: "DOWNLOAD_XHS_IMAGES", images });
            ok = Boolean(res && res.ok);
        } catch (e) {}

        if (!ok) {
            // 降级：Shadow DOM 内依次触发 <a> 下载 01.png ~ 0N.png
            for (let i = 0; i < images.length; i++) {
                const dUrl = images[i];
                const ext = /^data:image\/jpeg/i.test(dUrl) ? "jpg" : "png";
                const a = document.createElement("a");
                a.href = dUrl;
                a.download = `${String(i + 1).padStart(2, "0")}.${ext}`;
                shadow.appendChild(a);
                a.click();
                a.remove();
                await new Promise(r => setTimeout(r, 180));
            }
            ok = true;
        }

        dlBtn.disabled = false;
        dlBtn.textContent = "📥 一键下载全部套卡图片";
        dlStatus.textContent = ok
            ? `✔ 已触发保存 01~${String(images.length).padStart(2, "0")} 图片至下载目录，框选拖入左侧即可！`
            : "⚠️ 下载受限，请检查浏览器下载权限";
    };
    imgCard.appendChild(dlBtn);
    imgCard.appendChild(dlStatus);
    body.appendChild(imgCard);

    // 2. 标题一键复制 (xx/20)
    const xhsTitle = String(xhs.title || "").trim();
    const titleLen = Array.from(xhsTitle).length;
    const titleCard = document.createElement("div");
    titleCard.className = "card";
    const titlePreview = document.createElement("div");
    titlePreview.className = "preview-box";
    titlePreview.textContent = xhsTitle || "（未提取到标题）";
    const copyTitleBtn = document.createElement("button");
    copyTitleBtn.type = "button";
    copyTitleBtn.className = "btn-copy";
    const defaultTitleBtnTxt = `📋 复制标题 (${titleLen}/20)`;
    copyTitleBtn.textContent = defaultTitleBtnTxt;
    copyTitleBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await copyTextWithFallback(xhsTitle, shadow);
        copyTitleBtn.textContent = ok ? "✔ 已复制标题" : "⚠️ 复制失败请手动选中";
        setTimeout(() => { copyTitleBtn.textContent = defaultTitleBtnTxt; }, 2200);
    };
    titleCard.appendChild(titlePreview);
    titleCard.appendChild(copyTitleBtn);
    body.appendChild(titleCard);

    // 3. 纯净正文一键复制（不含黑字话题）
    const cleanBody = String(xhs.bodyWithoutTags || "").trim();
    const bodyLen = Array.from(cleanBody).length;
    const bodyCard = document.createElement("div");
    bodyCard.className = "card";
    const bodyHead = document.createElement("div");
    bodyHead.className = "card-head";
    const bLbl = document.createElement("span");
    bLbl.textContent = "📝 纯净正文（已剥离末尾黑字话题）";
    const bCnt = document.createElement("span");
    bCnt.textContent = `${bodyLen}/1000`;
    bodyHead.appendChild(bLbl);
    bodyHead.appendChild(bCnt);

    const bodyPreview = document.createElement("div");
    bodyPreview.className = "preview-box";
    bodyPreview.textContent = cleanBody || "（正文为空）";

    const copyBodyBtn = document.createElement("button");
    copyBodyBtn.type = "button";
    copyBodyBtn.className = "btn-copy";
    const defaultBodyBtnTxt = "📋 复制纯净正文（不含黑字话题）";
    copyBodyBtn.textContent = defaultBodyBtnTxt;
    copyBodyBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const ok = await copyTextWithFallback(cleanBody, shadow);
        copyBodyBtn.textContent = ok ? "✔ 已复制纯净正文" : "⚠️ 复制失败请手动选中";
        setTimeout(() => { copyBodyBtn.textContent = defaultBodyBtnTxt; }, 2200);
    };
    bodyCard.appendChild(bodyHead);
    bodyCard.appendChild(bodyPreview);
    bodyCard.appendChild(copyBodyBtn);
    body.appendChild(bodyCard);

    // 4. 真蓝标 #话题 接力胶囊区
    const hashtags = Array.isArray(xhs.hashtags) ? xhs.hashtags : [];
    const tagCard = document.createElement("div");
    tagCard.className = "card";
    const tagHead = document.createElement("div");
    tagHead.className = "card-head";
    const tLbl = document.createElement("span");
    tLbl.textContent = `🏷️ 真蓝标 #话题 接力区 (${hashtags.length})`;
    tagHead.appendChild(tLbl);
    tagCard.appendChild(tagHead);

    const tagsWrap = document.createElement("div");
    tagsWrap.className = "tags-wrap";
    if (hashtags.length > 0) {
        hashtags.forEach(rawTag => {
            const cleanTag = String(rawTag || "").replace(/^#+/, "").trim();
            if (!cleanTag) return;
            const pill = document.createElement("button");
            pill.type = "button";
            pill.className = "tag-pill";
            const withHash = `#${cleanTag}`;
            pill.textContent = withHash;
            pill.onclick = async (ev) => {
                ev.stopPropagation();
                const ok = await copyTextWithFallback(withHash, shadow);
                if (ok) {
                    pill.classList.add("copied");
                    pill.textContent = `✔ ${withHash}`;
                }
            };
            tagsWrap.appendChild(pill);
        });
    } else {
        const emptyHint = document.createElement("span");
        emptyHint.style.cssText = "font-size:12px;color:#94a3b8;";
        emptyHint.textContent = "未提取到 #话题，可在正文末尾直接键入 #关键词";
        tagsWrap.appendChild(emptyHint);
    }
    tagCard.appendChild(tagsWrap);

    const tipBox = document.createElement("div");
    tipBox.className = "hint";
    tipBox.textContent = "💡 粘贴正文后，逐个粘贴话题并按一下键盘【回车】即变蓝色真话题！";
    tagCard.appendChild(tipBox);
    body.appendChild(tagCard);

    panel.appendChild(body);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
}