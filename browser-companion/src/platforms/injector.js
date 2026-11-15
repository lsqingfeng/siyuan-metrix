/**
 * Metrix Platform Unified Injector: 针对各大平台草稿箱编辑器的原生注入器
 */

(async function () {
    const href = location.href;
    console.log("[Metrix Injector] 检测到页面:", href);

    // 判断是否为草稿编辑页
    const isEditor = href.includes("zhuanlan.zhihu.com/write") ||
                     href.includes("zhuanlan.zhihu.com/p/") ||
                     href.includes("juejin.cn/editor/drafts") ||
                     href.includes("editor.csdn.net/md") ||
                     href.includes("mp.csdn.net/mp_blog/creation/editor") ||
                     href.includes("mp.toutiao.com/profile_v4/graphic/publish") ||
                     href.includes("member.bilibili.com/york/read-editor") ||
                     href.includes("feishu.cn");

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

    const hostname = location.hostname;
    const article = currentTask.article;

    // B站专栏已通过官方草稿 API 创建并跳转 ?aid=xxx 时，直接提示成功并回传状态，避免重复覆盖
    if (hostname.includes("bilibili.com") && new URLSearchParams(location.search).get("aid")) {
        const doneKey = `metrix_bili_done_${currentTask.taskId}`;
        if (sessionStorage.getItem(doneKey) === "1") {
            showMetrixToast("✅ Metrix: B站专栏图文草稿已保存就绪！", 4000);
            chrome.runtime.sendMessage({
                type: "PLATFORM_DRAFT_STATUS",
                data: { platform: "bilibili", status: "success", draftUrl: location.href }
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
        if (hostname.includes("zhihu.com")) {
            await handlePageBridgeOrFallback("zhihu", article, injectZhihuFallback);
        } else if (hostname.includes("juejin.cn")) {
            await handlePageBridgeOrFallback("juejin", article, injectJuejinFallback);
        } else if (hostname.includes("csdn.net")) {
            await handlePageBridgeOrFallback("csdn", article, injectCSDNFallback);
        } else if (hostname.includes("toutiao.com")) {
            await injectToutiao(article);
        } else if (hostname.includes("bilibili.com")) {
            await handlePageBridgeOrFallback("bilibili", article, injectBilibiliFallback);
        } else if (hostname.includes("feishu.cn")) {
            await handleFeishu(article);
        }
    } catch (err) {
        console.error("[Metrix Injector] 注入异常:", err);
    }
})();

/**
 * 优先调用 background 运行在页面 MAIN world 中的原生桥接器，享有页面 JS 实例访问权
 */
async function handlePageBridgeOrFallback(platformId, article, fallbackFn) {
    console.log(`[Metrix Injector] 请求 ${platformId} 原生页面桥接注入...`);
    try {
        if (platformId === "bilibili") {
            const storage = await chrome.storage.local.get("currentTask");
            const tid = storage?.currentTask?.taskId;
            if (tid) sessionStorage.setItem(`metrix_bili_done_${tid}`, "1");
        }
        const res = await chrome.runtime.sendMessage({
            type: "FILL_PLATFORM_EDITOR",
            platformId,
            title: article.title,
            html: article.html,
            markdown: article.markdown,
            digest: article.digest || "",
            tags: article.tags || [],
            coverBase64: article.coverBase64 || "",
            assets: article.assets || []
        });

        if (res && res.ok && res.result) {
            console.log(`[Metrix Injector] ${platformId} 原生页面桥接注入成功:`, res.result);
            chrome.runtime.sendMessage({
                type: "PLATFORM_DRAFT_STATUS",
                data: { platform: platformId, status: "success", draftUrl: res.result.draftUrl || location.href }
            });
            return;
        }
    } catch (bridgeErr) {
        console.warn(`[Metrix Injector] ${platformId} 页面桥接失败，启动 DOM 降级兜底:`, bridgeErr);
    }

    // 降级执行 DOM 注入
    await fallbackFn(article);
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