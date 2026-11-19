"use strict";

const siyuan = require("siyuan");

// 安全获取 Node 原生模块 (兼容 Electron 渲染进程环境)
let http = null;
let https = null;
let fs = null;
let path = null;
let nodeCrypto = null;
let os = null;
try {
    const req = typeof window !== "undefined" && window.require ? window.require : require;
    http = req("http");
    https = req("https");
    fs = req("fs");
    path = req("path");
    nodeCrypto = req("crypto");
    os = req("os");
} catch (e) {
    console.warn("[Metrix] Node 原生模块加载提示:", e);
}

// 商用售卖购买落地页地址 (爱发电单品自动发卡直达链接)
const PURCHASE_PRO_URL = "https://afdian.com/item/e617d03cddba11f1bb3552540025c377";
const FREE_DEFAULT_CAPSULE = "【深度技术剖析 · 生产实战】";
const FREE_MAX_PLATFORMS = 1;
const FREE_DAILY_LIMIT = 3;

/**
 * 1. MatrixBridgeServer: 纯 Node.js 本地私有 HTTP 桥接服务
 */
class MatrixBridgeServer {
    constructor(port = 18999) {
        this.port = port;
        this.server = null;
        this.activeTasks = new Map();
        this.isRunning = false;
        this.statusCallbacks = [];
    }

    onStatus(callback) {
        this.statusCallbacks.push(callback);
    }

    start() {
        if (!http) {
            console.error("[MatrixBridge] 当前环境不支持 http 模块");
            return Promise.resolve(this.port);
        }
        if (this.isRunning) return Promise.resolve(this.port);

        return new Promise((resolve) => {
            try {
                this.server = http.createServer((req, res) => {
                    this.handleRequest(req, res);
                });

                this.server.on("error", (err) => {
                    console.error("[MatrixBridge] Server error:", err);
                    if (err.code === "EADDRINUSE") {
                        this.port += 1;
                        console.warn(`[MatrixBridge] 端口被占用，尝试备用端口: ${this.port}`);
                        this.server.listen(this.port, "127.0.0.1");
                    }
                });

                this.server.listen(this.port, "127.0.0.1", () => {
                    this.isRunning = true;
                    console.log(`[MatrixBridge] 本地桥接服务已就绪: http://127.0.0.1:${this.port}`);
                    resolve(this.port);
                });
            } catch (err) {
                console.error("[MatrixBridge] 启动异常:", err);
                resolve(this.port);
            }
        });
    }

    stop() {
        if (this.server) {
            try { this.server.close(); } catch (e) {}
            this.server = null;
            this.isRunning = false;
            this.activeTasks.clear();
        }
    }

    registerTask(taskId, taskData, token, assetsMap = new Map()) {
        this.activeTasks.set(taskId, {
            task: taskData,
            token: token,
            assets: assetsMap,
            createdAt: Date.now()
        });

        setTimeout(() => {
            if (this.activeTasks.has(taskId)) {
                this.activeTasks.delete(taskId);
            }
        }, 30 * 60 * 1000);
    }

    handleRequest(req, res) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Matrix-Token, Authorization");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
        const pathname = url.pathname;

        if (pathname === "/matrix-bridge") {
            this.serveBridgeLanding(res);
            return;
        }

        if (pathname === "/health") {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("OK");
            return;
        }

        const manifestMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/manifest$/);
        if (manifestMatch && req.method === "GET") {
            const taskId = manifestMatch[1];
            const entry = this.activeTasks.get(taskId);
            if (!entry) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Task not found or expired" }));
                return;
            }

            const clientToken = req.headers["x-matrix-token"] || url.searchParams.get("token");
            if (clientToken && clientToken !== entry.token) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid task token" }));
                return;
            }

            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ code: 0, data: entry.task }));
            return;
        }

        const assetMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/assets\/([^/]+)$/);
        if (assetMatch && req.method === "GET") {
            const taskId = assetMatch[1];
            const assetId = assetMatch[2];
            const entry = this.activeTasks.get(taskId);
            if (!entry || !entry.assets.has(assetId)) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Asset not found" }));
                return;
            }

            const asset = entry.assets.get(assetId);
            const mimeType = asset.mimeType || "image/png";

            if (asset.buffer) {
                res.writeHead(200, { "Content-Type": mimeType, "Content-Length": asset.buffer.length });
                res.end(asset.buffer);
                return;
            }

            if (fs && asset.filePath && fs.existsSync(asset.filePath)) {
                const stat = fs.statSync(asset.filePath);
                res.writeHead(200, { "Content-Type": mimeType, "Content-Length": stat.size });
                const readStream = fs.createReadStream(asset.filePath);
                readStream.pipe(res);
                return;
            }

            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Asset content missing" }));
            return;
        }

        const statusMatch = pathname.match(/^\/api\/v2\/tasks\/([^/]+)\/status$/);
        if (statusMatch && req.method === "POST") {
            const taskId = statusMatch[1];
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                try {
                    const statusData = JSON.parse(body);
                    this.statusCallbacks.forEach(cb => cb({ taskId, ...statusData }));
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ code: 0, msg: "Status received" }));
                } catch (e) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Invalid JSON body" }));
                }
            });
            return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }

    serveBridgeLanding(res) {
        const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Metrix 发布助手同步中</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #090d16;
      color: #f1f5f9;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 85vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #131b2e;
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 40px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      background: #1e3a8a;
      color: #60a5fa;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 20px;
    }
    h1 { font-size: 22px; margin: 0 0 12px 0; color: #ffffff; }
    #matrix-bridge-status { font-size: 15px; color: #38bdf8; line-height: 1.6; margin: 16px 0; }
    p.hint { color: #64748b; font-size: 13px; line-height: 1.6; margin: 20px 0 0 0; }
    .spinner {
      display: inline-block;
      width: 28px;
      height: 28px;
      border: 3px solid rgba(56, 189, 248, 0.2);
      border-radius: 50%;
      border-top-color: #38bdf8;
      animation: spin 1s ease-in-out infinite;
      margin-bottom: 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <div class="badge">Metrix Dispatch v2.3.0</div>
    <h1>🚀 思源自媒体矩阵分发</h1>
    <div id="matrix-bridge-status">正在连接浏览器伴侣扩展，为你准备草稿...</div>
    <p class="hint">各大平台的草稿将在当前浏览器中就绪，最终发布由你人工核对后手动确认。</p>
  </div>
</body>
</html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
    }
}

/**
 * 2. CoverRenderer: 纯前端 HTML5 Canvas 极客封面图渲染器
 */
class CoverRenderer {
    static async renderWechatCover(title, subtitle = "【深度技术剖析 · 生产实战】", tags = "架构师实战 · 生产环境落地指南") {
        const width = 900;
        const height = 383;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");

        const bgGrad = ctx.createLinearGradient(0, 0, width, height);
        bgGrad.addColorStop(0, "#0b1120");
        bgGrad.addColorStop(1, "#0f172a");
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = "rgba(30, 41, 59, 0.6)";
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 45) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        for (let y = 0; y < height; y += 45) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }

        const glowGrad = ctx.createRadialGradient(width - 180, 70, 0, width - 180, 70, 240);
        glowGrad.addColorStop(0, "rgba(37, 99, 235, 0.35)");
        glowGrad.addColorStop(0.5, "rgba(56, 189, 248, 0.15)");
        glowGrad.addColorStop(1, "rgba(11, 17, 32, 0)");
        ctx.fillStyle = glowGrad;
        ctx.fillRect(0, 0, width, height);

        ctx.font = "bold 15px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
        const badgeMetrics = ctx.measureText(subtitle);
        const badgeW = badgeMetrics.width + 28;
        const badgeH = 34;
        const badgeX = 55;
        const badgeY = 48;

        ctx.fillStyle = "rgba(30, 41, 59, 0.85)";
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 8);
        ctx.fill();

        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.fillStyle = "#60a5fa";
        ctx.textBaseline = "middle";
        ctx.fillText(subtitle, badgeX + 14, badgeY + badgeH / 2);

        const cleanTitle = title.replace(/^[#\s]+/, "").trim();
        let fontSize = 34;
        ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;

        let { line1, line2 } = this.splitTitleSmart(cleanTitle, (str) => ctx.measureText(str).width, 770);

        // 如果第二行依然超出最大宽度，动态缩窄字号
        if (line2 && ctx.measureText(line2).width > 770) {
            fontSize = 30;
            ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
            const re = this.splitTitleSmart(cleanTitle, (str) => ctx.measureText(str).width, 770);
            line1 = re.line1;
            line2 = re.line2;
        }

        ctx.textBaseline = "top";
        ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
        ctx.fillStyle = "#ffffff";
        ctx.fillText(line1, 55, 120);

        if (line2) {
            ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
            ctx.fillStyle = "#38bdf8";
            ctx.fillText(line2, 55, 120 + fontSize + 20);
        }

        ctx.font = "16px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText(tags, 55, 290);

        return canvas;
    }

    /**
     * 智能断句：绝不在英文单词（如 Obsidian, Cursor, Redis）中间折断
     */
    static splitTitleSmart(title, measureFn, maxLineWidth = 770, balanceThreshold = 520) {
        title = (title || "").replace(/^[#\s]+/, "").trim();
        if (!title) return { line1: "", line2: "" };

        const totalWidth = measureFn(title);
        if (totalWidth <= balanceThreshold) {
            return { line1: title, line2: "" };
        }

        // 1. 优先在自然标点处断句（冒号、破折号、分号、问号、逗号）
        const punctBreak = ["：", ":", "——", " | ", "？", "?", "！", "!", "，", ","];
        for (const p of punctBreak) {
            const idx = title.indexOf(p);
            if (idx >= 3 && idx < title.length - 2) {
                const cutIdx = idx + (p.trim().length === 1 && !/[a-zA-Z0-9]/.test(p) ? p.length : 0);
                const part1 = title.substring(0, cutIdx).trim();
                const part2 = title.substring(idx + p.length).trim();
                if (measureFn(part1) <= maxLineWidth && measureFn(part2) <= maxLineWidth) {
                    return { line1: part1, line2: part2 };
                }
            }
        }

        // 2. 将标题拆解为原子 Token（英文单词、数字、版本号视为不可分割整体）
        const tokens = title.match(/[a-zA-Z0-9_\-\.\+]+|[^\s\w]|\s+/g) || [title];
        const targetWidth = Math.min(maxLineWidth * 0.75, totalWidth * 0.52);
        let line1 = "";
        let line2 = "";
        let i = 0;

        for (; i < tokens.length; i++) {
            const token = tokens[i];
            const nextCandidate = line1 + token;
            const nextWidth = measureFn(nextCandidate.trim());

            if (nextWidth > maxLineWidth) {
                break;
            }

            // 达到视觉平衡线且遇到空格或汉字边界时折行
            if (nextWidth >= targetWidth && (token === " " || /[\u4e00-\u9fa5\uff00-\uffef]/.test(token))) {
                line1 = nextCandidate;
                i++;
                break;
            }

            line1 = nextCandidate;
        }

        line1 = line1.trim();
        line2 = tokens.slice(i).join("").trim();

        return { line1, line2 };
    }

    static splitTitle(title, maxCharsPerLine = 18) {
        return this.splitTitleSmart(title, (str) => str.length * 34, maxCharsPerLine * 34);
    }

    static canvasToBuffer(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error("Canvas toBlob 返回为空"));
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => {
                    const arrayBuffer = reader.result;
                    const buffer = typeof Buffer !== "undefined" ? Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer);
                    resolve(buffer);
                };
                reader.onerror = () => reject(reader.error || new Error("FileReader 读取 Canvas 失败"));
                reader.readAsArrayBuffer(blob);
            }, "image/png");
        });
    }

    static canvasToDataURL(canvas) {
        return canvas.toDataURL("image/png");
    }

    /**
     * 按像素宽度智能折行（保护英文单词/数字不被截断）
     */
    static wrapTextToLines(ctx, text, maxWidth) {
        const clean = String(text || "").replace(/\s+/g, " ").trim();
        if (!clean) return [];
        const tokens = clean.match(/[a-zA-Z0-9_.\-+#@:/]+|\s+|[^\s]/g) || [clean];
        const lines = [];
        let cur = "";

        for (const tok of tokens) {
            const candidate = cur + tok;
            if (ctx.measureText(candidate).width <= maxWidth) {
                cur = candidate;
                continue;
            }
            if (cur.trim()) {
                lines.push(cur.trimEnd());
                cur = tok.trimStart();
            } else {
                cur = tok;
            }
            // 单个超长英文/URL Token 硬折行
            while (cur && ctx.measureText(cur).width > maxWidth) {
                const chars = Array.from(cur);
                let cut = chars.length - 1;
                while (cut > 1 && ctx.measureText(chars.slice(0, cut).join("")).width > maxWidth) {
                    cut--;
                }
                lines.push(chars.slice(0, cut).join(""));
                cur = chars.slice(cut).join("");
            }
        }
        if (cur.trim()) lines.push(cur.trimEnd());
        return lines;
    }

    /**
     * 将 Markdown 清洗并结构化为卡片排版块，保留标题/列表/引用视觉层级
     */
    static buildNewspicCardBlocks(markdown, title = "") {
        let text = String(markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/^---[\r\n]+[\s\S]*?[\r\n]+---[\r\n]*/, "");
        text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
        text = text.replace(/<img\b[^>]*>/gi, "");
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (label && label.trim() ? label.trim() : url));
        text = text.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, "$1");
        text = text.replace(/(\*\*|__|~~|`)/g, "");

        const normTitle = String(title || "").replace(/\s+/g, " ").trim();
        const rawLines = text.split("\n");
        const blocks = [];
        let skippedDupTitle = false;

        for (let i = 0; i < rawLines.length; i++) {
            const line = rawLines[i].trim();
            if (!line || /^(?:---|\*\*\*|___)$/.test(line)) continue;
            if (!skippedDupTitle && normTitle && line.replace(/^#+\s+/, "").replace(/\s+/g, " ") === normTitle) {
                skippedDupTitle = true;
                continue;
            }

            const hMatch = line.match(/^#{1,4}[ \t]+(.+)$/);
            if (hMatch) {
                blocks.push({ type: "heading", text: hMatch[1].trim() });
                continue;
            }
            const qMatch = line.match(/^>[ \t]?(.*)$/);
            if (qMatch) {
                const qText = qMatch[1].trim();
                if (qText) blocks.push({ type: "quote", text: qText });
                continue;
            }
            const ulMatch = line.match(/^[-*+][ \t]+(.+)$/);
            if (ulMatch) {
                blocks.push({ type: "bullet", marker: "•", text: ulMatch[1].trim() });
                continue;
            }
            const olMatch = line.match(/^(\d+\.)[ \t]+(.+)$/);
            if (olMatch) {
                blocks.push({ type: "bullet", marker: olMatch[1], text: olMatch[2].trim() });
                continue;
            }
            blocks.push({ type: "para", text: line });
        }

        if (blocks.length === 0 && normTitle) {
            blocks.push({ type: "para", text: normTitle });
        }
        return blocks;
    }

    /**
     * 无图自动兜底：纯前端 Canvas 生成 1080×1440 (3:4) 高颜值极客卡片组（自动折行分页 1~4 张）
     */
    static async renderNewspicCards({ title = "", markdown = "", author = "", capsule = "", theme = "light", maxCards = 4 } = {}) {
        const width = 1080;
        const height = 1440;
        const isDark = theme === "dark";
        const palette = isDark
            ? {
                outerBg: "#070b14",
                dot: "rgba(148, 163, 184, 0.14)",
                cardBg: "#0f172a",
                cardBorder: "#1e293b",
                title: "#f8fafc",
                heading: "#38bdf8",
                body: "#cbd5e1",
                muted: "#94a3b8",
                accent: "#38bdf8",
                accentSoft: "rgba(56, 189, 248, 0.14)",
                quoteBg: "rgba(30, 41, 59, 0.85)",
                divider: "#1e293b"
            }
            : {
                outerBg: "#f1f5f9",
                dot: "rgba(100, 116, 139, 0.16)",
                cardBg: "#ffffff",
                cardBorder: "#e2e8f0",
                title: "#0f172a",
                heading: "#0f172a",
                body: "#334155",
                muted: "#64748b",
                accent: "#0284c7",
                accentSoft: "rgba(2, 132, 199, 0.09)",
                quoteBg: "#f0f9ff",
                divider: "#e2e8f0"
            };

        const cleanTitle = String(title || "").replace(/^[#\s]+/, "").trim() || "思源精选笔记";
        const cleanCapsule = String(capsule || "").trim() || "【极客手记 · 图文精选】";
        const cleanAuthor = String(author || "").trim() || "Metrix";
        const fontFamily = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";

        // 测量专用临时画布
        const measureCanvas = document.createElement("canvas");
        measureCanvas.width = width;
        measureCanvas.height = height;
        const mCtx = measureCanvas.getContext("2d");
        if (!mCtx) {
            throw new Error("Canvas 2D 测量上下文初始化失败");
        }

        const padX = 112;
        const contentW = width - padX * 2; // 856px
        const bottomLimitY = 1265;

        mCtx.font = `800 46px ${fontFamily}`;
        const heroTitleLines = this.wrapTextToLines(mCtx, cleanTitle, contentW).slice(0, 3);
        const firstCardStartY = 178 + heroTitleLines.length * 64 + 50;
        const nextCardStartY = 196;

        const rawBlocks = this.buildNewspicCardBlocks(markdown, cleanTitle);

        // 先将块转化为按行度量好的渲染单元
        const items = [];
        for (const blk of rawBlocks) {
            if (blk.type === "heading") {
                mCtx.font = `700 34px ${fontFamily}`;
                const lines = this.wrapTextToLines(mCtx, blk.text, contentW - 22);
                items.push({ type: "heading", lines, lineH: 48, gapTop: 18, gapBottom: 10 });
            } else if (blk.type === "quote") {
                mCtx.font = `500 30px ${fontFamily}`;
                const lines = this.wrapTextToLines(mCtx, blk.text, contentW - 44);
                items.push({ type: "quote", lines, lineH: 46, gapTop: 10, gapBottom: 16 });
            } else if (blk.type === "bullet") {
                mCtx.font = `400 31px ${fontFamily}`;
                const lines = this.wrapTextToLines(mCtx, blk.text, contentW - 42);
                items.push({ type: "bullet", marker: blk.marker, lines, lineH: 50, gapTop: 6, gapBottom: 12 });
            } else {
                mCtx.font = `400 31px ${fontFamily}`;
                const lines = this.wrapTextToLines(mCtx, blk.text, contentW);
                items.push({ type: "para", lines, lineH: 50, gapTop: 4, gapBottom: 18 });
            }
        }

        // 自动分页到 1..maxCards 张卡片
        const pages = [[]];
        let curY = firstCardStartY;
        let truncatedOverflow = false;

        for (let idx = 0; idx < items.length; idx++) {
            const it = items[idx];
            const pageIndex = pages.length - 1;
            const totalItemH = it.gapTop + it.lines.length * it.lineH + (it.type === "quote" ? 24 : 0) + it.gapBottom;

            if (curY + totalItemH <= bottomLimitY) {
                pages[pageIndex].push(it);
                curY += totalItemH;
                continue;
            }

            // 如果当前页剩余空间足够放 >= 2 行普通段落，拆分折行续页
            if (it.type === "para" && it.lines.length >= 3) {
                const availLines = Math.floor((bottomLimitY - curY - it.gapTop - it.gapBottom) / it.lineH);
                if (availLines >= 2) {
                    const headPart = { ...it, lines: it.lines.slice(0, availLines) };
                    const tailPart = { ...it, lines: it.lines.slice(availLines) };
                    pages[pageIndex].push(headPart);
                    items.splice(idx + 1, 0, tailPart);
                    if (pages.length < maxCards) {
                        pages.push([]);
                        curY = nextCardStartY;
                        continue;
                    } else {
                        truncatedOverflow = true;
                        break;
                    }
                }
            }

            if (pages.length < maxCards) {
                pages.push([]);
                curY = nextCardStartY;
                idx--; // 放到下一页重排版
            } else {
                // 最后一页兜底尽可能放入剩余行
                const availLines = Math.floor((bottomLimitY - curY - it.gapTop - 10) / it.lineH);
                if (availLines >= 1 && it.lines.length > 0) {
                    pages[pageIndex].push({ ...it, lines: it.lines.slice(0, availLines) });
                }
                truncatedOverflow = true;
                break;
            }
        }

        if (truncatedOverflow) {
            const lastPage = pages[pages.length - 1];
            lastPage.push({ type: "ellipsis", lines: ["……（完整细节见正文笔记）"], lineH: 42, gapTop: 8, gapBottom: 6 });
        }

        const totalPages = pages.length;
        const renderedCards = [];

        for (let p = 0; p < totalPages; p++) {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
                throw new Error(`Canvas 2D 绘制上下文初始化失败 (第 ${p + 1} 张)`);
            }

            // 外层背景与精致点阵
            ctx.fillStyle = palette.outerBg;
            ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = palette.dot;
            for (let gx = 24; gx < width; gx += 36) {
                for (let gy = 24; gy < height; gy += 36) {
                    ctx.beginPath();
                    ctx.arc(gx, gy, 1.5, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // 居中主卡片阴影与边框
            ctx.save();
            ctx.shadowColor = isDark ? "rgba(0, 0, 0, 0.55)" : "rgba(15, 23, 42, 0.08)";
            ctx.shadowBlur = 34;
            ctx.shadowOffsetY = 12;
            ctx.fillStyle = palette.cardBg;
            ctx.beginPath();
            ctx.roundRect(48, 48, width - 96, height - 96, 28);
            ctx.fill();
            ctx.restore();

            ctx.strokeStyle = palette.cardBorder;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(48, 48, width - 96, height - 96, 28);
            ctx.stroke();

            // 顶部极客蓝渐变装饰条
            ctx.save();
            ctx.beginPath();
            ctx.roundRect(48, 48, width - 96, height - 96, 28);
            ctx.clip();
            const barGrad = ctx.createLinearGradient(48, 48, width - 48, 48);
            barGrad.addColorStop(0, "#0284c7");
            barGrad.addColorStop(1, "#38bdf8");
            ctx.fillStyle = barGrad;
            ctx.fillRect(48, 48, width - 96, 10);
            ctx.restore();

            let drawY = 0;
            if (p === 0) {
                // Card 1: 顶部胶囊 + 巨幕标题 + 分割短条
                ctx.font = `700 22px ${fontFamily}`;
                const capW = Math.min(contentW, ctx.measureText(cleanCapsule).width + 36);
                ctx.fillStyle = palette.accentSoft;
                ctx.beginPath();
                ctx.roundRect(padX, 102, capW, 44, 10);
                ctx.fill();
                ctx.fillStyle = palette.accent;
                ctx.textBaseline = "middle";
                ctx.fillText(cleanCapsule, padX + 18, 124, contentW - 36);

                ctx.font = `800 46px ${fontFamily}`;
                ctx.fillStyle = palette.title;
                ctx.textBaseline = "top";
                let ty = 178;
                for (const tLine of heroTitleLines) {
                    ctx.fillText(tLine, padX, ty);
                    ty += 64;
                }

                const sepGrad = ctx.createLinearGradient(padX, ty + 14, padX + 120, ty + 14);
                sepGrad.addColorStop(0, "#0284c7");
                sepGrad.addColorStop(1, "#38bdf8");
                ctx.fillStyle = sepGrad;
                ctx.beginPath();
                ctx.roundRect(padX, ty + 12, 110, 6, 3);
                ctx.fill();
                drawY = firstCardStartY;
            } else {
                // Card 2..N: 顶部紧凑导读条
                ctx.font = `600 23px ${fontFamily}`;
                ctx.fillStyle = palette.muted;
                ctx.textBaseline = "top";
                const shortHeader = Array.from(cleanTitle).slice(0, 26).join("") + (Array.from(cleanTitle).length > 26 ? "…" : "");
                ctx.fillText(shortHeader, padX, 104);
                ctx.strokeStyle = palette.divider;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(padX, 154);
                ctx.lineTo(width - padX, 154);
                ctx.stroke();
                drawY = nextCardStartY;
            }

            // 绘制正文内容块
            ctx.textBaseline = "top";
            for (const blk of pages[p]) {
                drawY += blk.gapTop;
                if (blk.type === "heading") {
                    const hHeight = blk.lines.length * blk.lineH;
                    ctx.fillStyle = palette.accent;
                    ctx.beginPath();
                    ctx.roundRect(padX, drawY + 6, 8, Math.max(28, hHeight - 12), 4);
                    ctx.fill();
                    ctx.font = `700 34px ${fontFamily}`;
                    ctx.fillStyle = palette.heading;
                    for (const line of blk.lines) {
                        ctx.fillText(line, padX + 22, drawY);
                        drawY += blk.lineH;
                    }
                } else if (blk.type === "quote") {
                    const qBoxH = blk.lines.length * blk.lineH + 24;
                    ctx.fillStyle = palette.quoteBg;
                    ctx.beginPath();
                    ctx.roundRect(padX, drawY, contentW, qBoxH, 12);
                    ctx.fill();
                    ctx.fillStyle = palette.accent;
                    ctx.fillRect(padX, drawY, 6, qBoxH);
                    ctx.font = `500 30px ${fontFamily}`;
                    ctx.fillStyle = palette.body;
                    let qy = drawY + 12;
                    for (const line of blk.lines) {
                        ctx.fillText(line, padX + 24, qy);
                        qy += blk.lineH;
                    }
                    drawY += qBoxH;
                } else if (blk.type === "bullet") {
                    ctx.font = `700 30px ${fontFamily}`;
                    ctx.fillStyle = palette.accent;
                    ctx.fillText(blk.marker, padX, drawY);
                    ctx.font = `400 31px ${fontFamily}`;
                    ctx.fillStyle = palette.body;
                    for (const line of blk.lines) {
                        ctx.fillText(line, padX + 42, drawY);
                        drawY += blk.lineH;
                    }
                } else if (blk.type === "ellipsis") {
                    ctx.font = `600 26px ${fontFamily}`;
                    ctx.fillStyle = palette.muted;
                    ctx.fillText(blk.lines[0], padX, drawY);
                    drawY += blk.lineH;
                } else {
                    ctx.font = `400 31px ${fontFamily}`;
                    ctx.fillStyle = palette.body;
                    for (const line of blk.lines) {
                        ctx.fillText(line, padX, drawY);
                        drawY += blk.lineH;
                    }
                }
                drawY += blk.gapBottom;
            }

            // 底部栏：作者署名 + 页码胶囊
            ctx.strokeStyle = palette.divider;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(padX, 1296);
            ctx.lineTo(width - padX, 1296);
            ctx.stroke();

            ctx.font = `600 24px ${fontFamily}`;
            ctx.fillStyle = palette.muted;
            ctx.textBaseline = "middle";
            ctx.fillText(`@ ${cleanAuthor}`, padX, 1338);

            const pageStr = `${String(p + 1).padStart(2, "0")} / ${String(totalPages).padStart(2, "0")}`;
            const pageW = ctx.measureText(pageStr).width + 30;
            ctx.fillStyle = palette.accentSoft;
            ctx.beginPath();
            ctx.roundRect(width - padX - pageW, 1318, pageW, 40, 20);
            ctx.fill();
            ctx.fillStyle = palette.accent;
            ctx.fillText(pageStr, width - padX - pageW + 15, 1338);

            const dataUrl = this.canvasToDataURL(canvas);
            const buffer = await this.canvasToBuffer(canvas);
            renderedCards.push({
                buffer,
                dataUrl,
                mimeType: "image/png",
                ext: "png",
                filename: `metrix_card_${String(p + 1).padStart(2, "0")}.png`
            });
        }

        return renderedCards;
    }
}

/**
 * 3. DocParser: 文档解析与标题摘要提取
 */
class DocParser {
    static getActiveDocFromDOM(pluginInstance) {
        // 1. 优先扫描中心工作区内所有未隐藏的编辑器
        const protyles = Array.from(document.querySelectorAll(".layout__center .protyle, .protyle"));
        for (const p of protyles) {
            if (p.closest(".fn__none") || p.classList.contains("fn__none")) continue;
            const titleEl = p.querySelector(".protyle-title");
            const titleInput = titleEl?.querySelector(".protyle-title__input") || titleEl;
            const wysiwygEl = p.querySelector(".protyle-wysiwyg");
            const docId = titleEl?.getAttribute("data-node-id") 
                       || wysiwygEl?.getAttribute("data-node-id") 
                       || p.querySelector("[data-node-id]")?.getAttribute("data-node-id");
            const title = (titleInput?.innerText || titleInput?.textContent || "").trim();
            if (docId && /^\d{14}-[a-z0-9]{7}$/.test(docId)) {
                return { docId, title: title || "" };
            }
        }

        // 2. 从当前激活的标签页属性中提取
        const activeTab = document.querySelector(".layout-tab-bar .item--focus, .layout__center .item--focus, ul.layout-tab-bar > li.item--focus");
        if (activeTab) {
            const rawId = activeTab.getAttribute("data-id") || activeTab.getAttribute("data-node-id");
            const title = activeTab.querySelector(".item__text")?.innerText?.trim();
            if (rawId && /^\d{14}-[a-z0-9]{7}$/.test(rawId)) {
                return { docId: rawId, title: title || "" };
            }
            if (title) {
                return { docId: null, title: title };
            }
        }

        // 3. 从 DOM 中任意存在的 protyle-title 兜底
        const anyTitleEl = document.querySelector("div.protyle:not(.fn__none) .protyle-title[data-node-id], .protyle-title[data-node-id]");
        if (anyTitleEl) {
            const docId = anyTitleEl.getAttribute("data-node-id");
            const titleInput = anyTitleEl.querySelector(".protyle-title__input") || anyTitleEl;
            const title = (titleInput?.innerText || titleInput?.textContent || "").trim();
            if (docId && /^\d{14}-[a-z0-9]{7}$/.test(docId)) {
                return { docId, title };
            }
        }

        // 4. 从 EventBus 历史捕获记录兜底
        if (pluginInstance?.currentDocId && /^\d{14}-[a-z0-9]{7}$/.test(pluginInstance.currentDocId)) {
            return { docId: pluginInstance.currentDocId, title: pluginInstance.currentDocTitle || "" };
        }

        return null;
    }

    static async parseDocument(docId, initialTitle = "") {
        // 1. 查询块信息，若传入的是子块则溯源至文档 root_id
        let realDocId = docId;
        let blockRecord = null;
        if (docId) {
            try {
                const sqlRes = await fetch("/api/query/sql", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ stmt: `SELECT id, root_id, box, hpath, content, type FROM blocks WHERE id = '${docId}' LIMIT 1;` })
                });
                const sqlData = await sqlRes.json();
                const record = sqlData?.data?.[0];
                if (record) {
                    blockRecord = record;
                    if (record.root_id && record.root_id !== docId && record.type !== 'd') {
                        realDocId = record.root_id;
                        const rootSql = await fetch("/api/query/sql", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ stmt: `SELECT id, root_id, box, hpath, content, type FROM blocks WHERE id = '${realDocId}' LIMIT 1;` })
                        });
                        const rootData = await rootSql.json();
                        if (rootData?.data?.[0]) blockRecord = rootData.data[0];
                    }
                }
            } catch (e) {}
        }

        // 2. 如果未找到有效文档记录，用最近更新文档兜底
        if (!blockRecord || !realDocId) {
            try {
                let stmt = "SELECT id, root_id, box, hpath, content, type FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT 1;";
                if (initialTitle && initialTitle !== "思源自媒体文档") {
                    const cleanTitle = initialTitle.replace(/'/g, "''");
                    stmt = `SELECT id, root_id, box, hpath, content, type FROM blocks WHERE type = 'd' AND content = '${cleanTitle}' LIMIT 1;`;
                }
                const fbRes = await fetch("/api/query/sql", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ stmt })
                });
                const fbData = await fbRes.json();
                let match = fbData?.data?.[0];
                if (!match) {
                    const fbRes2 = await fetch("/api/query/sql", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ stmt: "SELECT id, root_id, box, hpath, content, type FROM blocks WHERE type = 'd' ORDER BY updated DESC LIMIT 1;" })
                    });
                    const fbData2 = await fbRes2.json();
                    match = fbData2?.data?.[0];
                }
                if (match) {
                    blockRecord = match;
                    realDocId = match.id;
                }
            } catch (e) {}
        }

        const hpath = blockRecord?.hpath || "";
        const boxId = blockRecord?.box || "";

        // 3. 导出 Markdown 正文
        let rawMarkdown = "";
        try {
            const expRes = await fetch("/api/export/exportMdContent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: realDocId })
            });
            const expData = await expRes.json();
            rawMarkdown = expData?.data?.content || "";
        } catch (e) {}

        // 4. 剥离 Frontmatter
        let cleanMd = rawMarkdown.replace(/^---[\r\n]+[\s\S]*?[\r\n]+---[\r\n]*/, "");

        // 5. 多级强力探测标题 (确保绝不为空)
        let detectedTitle = "";
        const lines = cleanMd.split(/\r?\n/);
        const h1Entries = [];
        for (const l of lines.slice(0, 20)) {
            const s = l.trim();
            if (!s) continue;
            if (s.startsWith("# ") && !s.startsWith("## ")) {
                h1Entries.push(s.substring(2).trim());
            } else if (h1Entries.length > 0) {
                break;
            }
        }
        if (h1Entries.length > 0) {
            detectedTitle = h1Entries.reduce((a, b) => b.length > a.length ? b : a);
        }

        if (!detectedTitle) {
            const fmMatch = rawMarkdown.match(/^title:\s*(.+)$/m);
            if (fmMatch && fmMatch[1]) detectedTitle = fmMatch[1].trim();
        }

        if (!detectedTitle && initialTitle && initialTitle !== "思源自媒体文档") {
            detectedTitle = initialTitle;
        }

        if (!detectedTitle && blockRecord?.content) {
            detectedTitle = blockRecord.content;
        }

        if (!detectedTitle && hpath) {
            const parts = hpath.split("/").filter(Boolean);
            if (parts.length) detectedTitle = parts[parts.length - 1];
        }

        // 关键修复：只有当去除日期前缀后依然包含有效字符时，才剔除日期；
        // 如果剔除日期后变空（如纯日期标题 2026-11-07），或者当前文档就是日常笔记，必须保留原标题，绝不能置空！
        let finalCleanTitle = (detectedTitle || "").trim();
        const withoutDate = finalCleanTitle.replace(/^\d{4}-\d{2}-\d{2}[_ -]?/, "").trim();
        if (withoutDate.length > 0) {
            finalCleanTitle = withoutDate;
        }
        if (!finalCleanTitle) {
            finalCleanTitle = (initialTitle && initialTitle !== "思源自媒体文档") ? initialTitle : (blockRecord?.content || "");
        }
        // 如果依然为空，从正文提取首个有效段落前 30 字作为标题
        if (!finalCleanTitle) {
            for (const l of lines) {
                const s = l.trim().replace(/^#+\s*/, "").replace(/[*_`#]/g, "").trim();
                if (s && !s.startsWith("---") && !s.startsWith(">") && s.length >= 2) {
                    finalCleanTitle = s.substring(0, 30);
                    break;
                }
            }
        }
        if (!finalCleanTitle) {
            finalCleanTitle = "思源精选手记";
        }
        detectedTitle = finalCleanTitle;

        // 6. 摘要提取：提取首段有意义正文
        let digest = "";
        for (const l of lines) {
            const trimmed = l.trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(">") || trimmed.startsWith("---") || trimmed.startsWith("|")) continue;
            const stripped = trimmed.replace(/[*_`#]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
            if (stripped.length >= 20) {
                digest = stripped.substring(0, 120);
                break;
            }
        }
        if (!digest && detectedTitle) {
            digest = `本文深度解析：${detectedTitle}`;
        }

        const assetRegex = /!\[([^\]]*)\]\((\.?\/?assets\/[^)\s"]+)(?:\s+"[^"]*")?\)/g;
        const referencedAssets = [];
        const seenRelPaths = new Set();
        let match;
        while ((match = assetRegex.exec(cleanMd)) !== null) {
            const alt = match[1];
            const relPath = match[2];
            if (seenRelPaths.has(relPath)) continue;
            seenRelPaths.add(relPath);
            const assetFilename = relPath.split("/").pop();
            referencedAssets.push({ alt, relPath, filename: assetFilename });
        }

        const orderedImages = this.extractOrderedImages(cleanMd, realDocId);

        let dataDir = "";
        try {
            if (typeof window !== "undefined" && window.siyuan?.config?.system) {
                const sys = window.siyuan.config.system;
                dataDir = sys.dataDir || (sys.workspaceDir && path ? path.join(sys.workspaceDir, "data") : "");
            }
            if (!dataDir) {
                const confRes = await fetch("/api/system/getConf", { method: "POST" });
                const confData = await confRes.json();
                const sysConf = confData?.data?.conf?.system;
                dataDir = sysConf?.dataDir || (sysConf?.workspaceDir && path ? path.join(sysConf.workspaceDir, "data") : "");
            }
        } catch (e) {}

        // 7. 剥离正文顶部的重复 H1 标题（各大平台已有独立标题栏，正文顶部无需再次出现大标题）
        let finalBodyMd = (cleanMd || "").trim();
        const firstH1Regex = /^\s*#\s+(.+?)(?:[\r\n]+|$)/;
        let h1StripCount = 0;
        while (h1StripCount < 3) {
            const h1Match = finalBodyMd.match(firstH1Regex);
            if (!h1Match) break;
            const h1Text = h1Match[1].trim();
            const isTitleMatch = !detectedTitle || h1Text === detectedTitle.trim() || detectedTitle.includes(h1Text) || h1Text.includes(detectedTitle);
            if (isTitleMatch) {
                finalBodyMd = finalBodyMd.replace(firstH1Regex, "").trim();
                h1StripCount++;
            } else {
                break;
            }
        }

        // 8. 规范化引用块与后续普通正文之间的空行，防止 CommonMark 懒引用延续导致正文全部坍缩进引用框
        finalBodyMd = finalBodyMd.replace(/(^>[^\r\n]*)(\r?\n)(?!>|\r?\n)/gm, "$1$2\n");

        return { docId: realDocId, boxId, hpath, title: detectedTitle, digest, markdown: finalBodyMd, referencedAssets, orderedImages, dataDir };
    }

    /**
     * 按出现顺序提取文档中的全部图片（支持 /assets/...、assets/... 及 http(s) 图，必要时回查 DOM）
     */
    static extractOrderedImages(markdown = "", docId = "", maxCount = 20) {
        const candidates = [];
        const mdImgRegex = /!\[([^\]]*)\]\(([^)\n]+?)(?:\s+"[^"]*")?\)/g;
        let m;
        while ((m = mdImgRegex.exec(markdown || "")) !== null) {
            candidates.push({ index: m.index, alt: (m[1] || "").trim(), rawSrc: (m[2] || "").trim() });
        }

        const htmlImgRegex = /<img\b[^>]*\bsrc=["']([^"'\s>]+)["'][^>]*>/gi;
        while ((m = htmlImgRegex.exec(markdown || "")) !== null) {
            candidates.push({ index: m.index, alt: "", rawSrc: (m[1] || "").trim() });
        }

        candidates.sort((a, b) => a.index - b.index);

        const normalizeSrc = (src) => {
            if (!src) return null;
            const clean = src.replace(/^<|>$/g, "").trim();
            if (/^https?:\/\//i.test(clean) || /^data:image\//i.test(clean)) {
                return { src: clean, isLocal: false, relPath: "" };
            }
            if (/^(?:\.?\.?\/)?assets\//i.test(clean)) {
                const relPath = clean.replace(/^(?:\.+\/)+/, "").replace(/^\/+/, "");
                return { src: relPath, isLocal: true, relPath };
            }
            return null;
        };

        const results = [];
        const seen = new Set();
        for (const item of candidates) {
            const norm = normalizeSrc(item.rawSrc);
            if (!norm) continue;
            const key = norm.isLocal ? norm.relPath : norm.src;
            if (seen.has(key)) continue;
            seen.add(key);
            results.push({
                src: norm.src,
                isLocal: norm.isLocal,
                relPath: norm.relPath,
                alt: item.alt,
                filename: key.split("/").pop().split("?")[0] || `image_${results.length + 1}.png`
            });
            if (results.length >= maxCount) return results;
        }

        // DOM 兜底：当 Markdown 未提取到图片时，读取当前激活编辑器 DOM 内展示的图片
        if (results.length === 0 && typeof document !== "undefined") {
            const scope = (docId && document.querySelector(`.protyle-wysiwyg[data-node-id="${docId}"]`))
                || document.querySelector(".layout__center .protyle:not(.fn__none) .protyle-wysiwyg")
                || document.querySelector(".protyle-wysiwyg");
            if (scope) {
                const imgs = Array.from(scope.querySelectorAll("img"));
                for (const imgEl of imgs) {
                    const rawSrc = imgEl.getAttribute("data-src") || imgEl.getAttribute("src") || "";
                    if (!rawSrc || rawSrc.includes("/emojis/") || rawSrc.includes("/appearance/") || rawSrc.startsWith("data:image/svg")) {
                        continue;
                    }
                    const norm = normalizeSrc(rawSrc);
                    if (!norm) continue;
                    const key = norm.isLocal ? norm.relPath : norm.src;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    results.push({
                        src: norm.src,
                        isLocal: norm.isLocal,
                        relPath: norm.relPath,
                        alt: imgEl.getAttribute("alt") || "",
                        filename: key.split("/").pop().split("?")[0] || `image_${results.length + 1}.png`
                    });
                    if (results.length >= maxCount) break;
                }
            }
        }

        return results;
    }

    /**
     * 解析小红书图文数据：<=20字短标题 + 剥离末尾 #话题 的纯净正文 + 独立话题词数组（去 # 号）
     */
    static parseXiaohongshuContent(markdown = "", title = "", fallbackTagsStr = "") {
        let text = String(markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/^---[\r\n]+[\s\S]*?[\r\n]+---[\r\n]*/, "");
        text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
        text = text.replace(/<img\b[^>]*>/gi, "");
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (label && label.trim() ? label.trim() : url));
        text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        text = text.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, "$1");
        text = text.replace(/^#{1,6}[ \t]+/gm, "");
        text = text.replace(/^>[ \t]?/gm, "");
        text = text.replace(/^(?:---|\*\*\*|___)$/gm, "");
        text = text.replace(/(\*\*|__|~~|`)/g, "");

        const cleanTitleRaw = String(title || "").replace(/^[#\s]+/, "").trim() || "思源图文手记";
        const xhsTitle = Array.from(cleanTitleRaw).slice(0, 20).join("");

        // 剥离开头与标题重复的首行
        const lines = text.split("\n");
        if (lines.length > 0 && lines[0].trim().replace(/\s+/g, " ") === cleanTitleRaw.replace(/\s+/g, " ")) {
            lines.shift();
        }

        // 提取全部有效 #话题（过滤十六进制色号与纯数字）
        const hashtags = [];
        const tagSeen = new Set();
        const addTag = (rawTag) => {
            const cleanTag = String(rawTag || "").replace(/^#+/, "").replace(/\[话题\]#?$/g, "").trim();
            if (!cleanTag || cleanTag.length > 30) return;
            if (/^[0-9a-fA-F]{3,8}$/.test(cleanTag) || /^\d+$/.test(cleanTag)) return;
            if (!tagSeen.has(cleanTag)) {
                tagSeen.add(cleanTag);
                hashtags.push(cleanTag);
            }
        };

        const tagBodyPattern = "[^\\s#\\n\\r\\[\\],，。；;！!？?、]{1,30}";
        const tagRegex = new RegExp(`(?:^|[\\s，,。；;！!？?、])#(${tagBodyPattern})(?:\\[话题\\]#)?`, "g");
        const fullClean = lines.join("\n");
        let tm;
        while ((tm = tagRegex.exec(fullClean)) !== null) {
            addTag(tm[1]);
        }

        // 从末尾向上剥离全部仅由 #话题 / 标签引导词构成的尾部段落或行尾连续 #话题 簇
        const trailingClusterRe = new RegExp(`(?:[\\s,，、;；]*#${tagBodyPattern}(?:\\[话题\\]#)?)+$`, "g");
        const stripAnyTagRe = new RegExp(`#${tagBodyPattern}(?:\\[话题\\]#)?`, "g");
        const anyTagTestRe = new RegExp(`#${tagBodyPattern}`);
        const stripInlineTagCluster = (line) => {
            return line
                .replace(trailingClusterRe, "")
                .replace(/^(?:标签|话题|Tags?)\s*[：:]\s*$/i, "")
                .trimEnd();
        };

        while (lines.length > 0) {
            const lastRaw = lines[lines.length - 1].trim();
            if (!lastRaw) {
                lines.pop();
                continue;
            }
            const withoutPrefix = lastRaw.replace(/^(?:标签|话题|Tags?)\s*[：:]\s*/i, "");
            const leftAfterTags = withoutPrefix.replace(stripAnyTagRe, "").replace(/[,，、;；\s]/g, "");
            if (anyTagTestRe.test(lastRaw) && !leftAfterTags) {
                lines.pop();
                continue;
            }
            const strippedTail = stripInlineTagCluster(lines[lines.length - 1]);
            if (strippedTail !== lines[lines.length - 1]) {
                if (strippedTail.trim()) {
                    lines[lines.length - 1] = strippedTail;
                } else {
                    lines.pop();
                }
            }
            break;
        }

        let bodyWithoutTags = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

        // 若正文完全无 #话题，则回退解析插件默认标签
        if (hashtags.length === 0 && fallbackTagsStr) {
            String(fallbackTagsStr)
                .split(/[,，\s]+/)
                .map(s => s.replace(/^#+/, "").trim())
                .filter(Boolean)
                .forEach(addTag);
        }

        return {
            title: xhsTitle,
            bodyWithoutTags,
            hashtags: hashtags.slice(0, 10)
        };
    }
}

/**
 * 4. ThemeEngine: 极客蓝内联排版引擎
 */
class ThemeEngine {
    static isGenericAlt(alt, relPath = "") {
        if (!alt) return true;
        const clean = alt.trim().toLowerCase();
        if (!clean) return true;

        // 1. 如果 alt 和图片相对路径/文件名一模一样，是占位符
        if (relPath) {
            const filename = relPath.split(/[/\\]/).pop().toLowerCase();
            if (clean === filename || clean === relPath.toLowerCase()) return true;
        }

        // 2. 匹配常见默认占位 alt：image, img, picture, photo, 截图, 屏幕截图, 微信截图, untitled, assets 等
        if (/^(image|img|picture|photo|截图|屏幕截图|微信截图|assets?|untitled)([-_.\d\s]*)(png|jpe?g|webp|gif)?$/i.test(clean)) {
            return true;
        }

        // 3. 匹配常见纯文件名或日期时间戳格式：如 2026-11-08_173829.png 或 20261108173829
        if (/^[\d_.\-\s]+(\.(png|jpe?g|webp|gif))?$/i.test(clean)) {
            return true;
        }

        return false;
    }

    static async resolveAssetBase64(relPath, dataDir) {
        if (!relPath) return null;
        const cleanRel = relPath.replace(/^[\.\/\\]+/, "").replace(/\\/g, "/");

        // 1. 本地 Node.js fs 极速读取
        if (fs && path && dataDir) {
            try {
                const diskPath = path.isAbsolute(cleanRel) ? cleanRel : path.join(dataDir, cleanRel);
                if (fs.existsSync(diskPath)) {
                    const buf = fs.readFileSync(diskPath);
                    const ext = path.extname(diskPath).toLowerCase().replace(".", "");
                    const mime = ext === "jpg" ? "jpeg" : (ext === "svg" ? "svg+xml" : (ext || "png"));
                    return `data:image/${mime};base64,${buf.toString("base64")}`;
                }
            } catch (e) {
                console.warn("[Metrix] 本地 fs 读取资源失败，尝试接口降级:", e);
            }
        }

        // 2. 思源内核 API /api/file/getFile 读取
        try {
            const apiRes = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: "/data/" + cleanRel })
            });
            if (apiRes.ok) {
                const blob = await apiRes.blob();
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(blob);
                });
            }
        } catch (e) {}

        // 3. 直接通过思源静态资源路径 fetch
        try {
            const fetchRes = await fetch("/" + cleanRel);
            if (fetchRes.ok) {
                const blob = await fetchRes.blob();
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(blob);
                });
            }
        } catch (e) {}

        return null;
    }

    static guessMimeFromName(nameOrUrl = "") {
        const clean = String(nameOrUrl || "").split("?")[0].split("#")[0].toLowerCase();
        if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
        if (clean.endsWith(".gif")) return "image/gif";
        if (clean.endsWith(".webp")) return "image/webp";
        if (clean.endsWith(".bmp")) return "image/bmp";
        if (clean.endsWith(".svg")) return "image/svg+xml";
        return "image/png";
    }

    static mimeToExt(mimeType = "image/png") {
        const m = String(mimeType || "").toLowerCase();
        if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
        if (m.includes("gif")) return "gif";
        if (m.includes("bmp")) return "bmp";
        if (m.includes("webp")) return "webp";
        if (m.includes("svg")) return "svg";
        return "png";
    }

    static bufferToDataUrl(buf, mimeType = "image/png") {
        if (!buf) return null;
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(buf)) {
            return `data:${mimeType};base64,${buf.toString("base64")}`;
        }
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return `data:${mimeType};base64,${btoa(bin)}`;
    }

    static fetchRemoteImageBuffer(targetUrl, redirectsLeft = 3) {
        if (!http || !https) {
            return (async () => {
                const r = await fetch(targetUrl);
                if (!r.ok) return null;
                const ct = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
                if (ct && !ct.startsWith("image/")) return null;
                const arrBuf = await r.arrayBuffer();
                return {
                    buffer: typeof Buffer !== "undefined" ? Buffer.from(arrBuf) : new Uint8Array(arrBuf),
                    mimeType: ct || this.guessMimeFromName(targetUrl)
                };
            })();
        }

        return new Promise((resolve) => {
            try {
                const parsed = new URL(targetUrl);
                const client = parsed.protocol === "http:" ? http : https;
                const req = client.request(
                    {
                        hostname: parsed.hostname,
                        port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
                        path: parsed.pathname + parsed.search,
                        method: "GET",
                        headers: {
                            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
                            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
                        },
                        agent: false
                    },
                    (res) => {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                            const nextUrl = new URL(res.headers.location, targetUrl).href;
                            res.resume();
                            resolve(this.fetchRemoteImageBuffer(nextUrl, redirectsLeft - 1));
                            return;
                        }
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            res.resume();
                            resolve(null);
                            return;
                        }
                        const ct = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
                        if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
                            res.resume();
                            resolve(null);
                            return;
                        }
                        const chunks = [];
                        res.on("data", c => chunks.push(c));
                        res.on("end", () => {
                            const buffer = Buffer.concat(chunks);
                            if (!buffer.length) {
                                resolve(null);
                                return;
                            }
                            const mimeType = (ct && ct.startsWith("image/")) ? ct : this.guessMimeFromName(targetUrl);
                            resolve({ buffer, mimeType });
                        });
                    }
                );
                req.setTimeout(15000, () => {
                    req.destroy();
                    resolve(null);
                });
                req.on("error", () => resolve(null));
                req.end();
            } catch (e) {
                resolve(null);
            }
        });
    }

    /**
     * 将 webp / svg / avif 等浏览器图片通过 Canvas 转为通用 PNG，确保微信素材库与小红书 100% 兼容
     */
    static async ensureUniversalPngIfNeeded(buffer, mimeType, filename = "image.png") {
        const lower = String(mimeType || "").toLowerCase();
        if (lower === "image/png" || lower === "image/jpeg" || lower === "image/jpg" || lower === "image/gif" || lower === "image/bmp") {
            const normMime = lower === "image/jpg" ? "image/jpeg" : lower;
            return {
                buffer,
                mimeType: normMime,
                dataUrl: this.bufferToDataUrl(buffer, normMime),
                ext: this.mimeToExt(normMime),
                filename
            };
        }
        if (typeof document !== "undefined" && typeof Image !== "undefined") {
            try {
                const srcDataUrl = this.bufferToDataUrl(buffer, lower || "image/webp");
                const img = await new Promise((resolve, reject) => {
                    const el = new Image();
                    el.onload = () => resolve(el);
                    el.onerror = reject;
                    el.src = srcDataUrl;
                });
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth || img.width || 1080;
                canvas.height = img.naturalHeight || img.height || 1440;
                const ctx = canvas.getContext("2d");
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const pngDataUrl = canvas.toDataURL("image/png");
                const b64 = pngDataUrl.split(",")[1] || "";
                const pngBuffer = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64") : buffer;
                const safeName = filename.replace(/\.[^.]+$/, "") + ".png";
                return {
                    buffer: pngBuffer,
                    mimeType: "image/png",
                    dataUrl: pngDataUrl,
                    ext: "png",
                    filename: safeName
                };
            } catch (e) {
                console.warn("[Metrix] 图片转 PNG 降级失败，保留原格式:", filename, e);
            }
        }
        return {
            buffer,
            mimeType: lower || "image/png",
            dataUrl: this.bufferToDataUrl(buffer, lower || "image/png"),
            ext: this.mimeToExt(lower),
            filename
        };
    }

    /**
     * 读取任意思源图片资源（支持 /assets/...、assets/...、http(s) 与 data:image）并返回 { buffer, dataUrl, mimeType, ext, filename }
     */
    static async resolveImagePayload(imgItem, dataDir = "") {
        if (!imgItem || !imgItem.src) return null;
        const src = String(imgItem.src).trim();
        const filename = imgItem.filename || "image.png";
        const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 微信素材库单图硬上限 10MB

        const finalizePayload = async (buf, mimeType, name) => {
            const len = buf?.byteLength ?? buf?.length ?? 0;
            if (!buf || len === 0 || len > MAX_IMAGE_BYTES) {
                console.warn("[Metrix] 图片体积超限(>10MB)或为空，已跳过:", name, len);
                return null;
            }
            return this.ensureUniversalPngIfNeeded(buf, mimeType, name);
        };

        if (src.startsWith("data:image/")) {
            const match = src.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s);
            if (!match) return null;
            const mimeType = match[1].toLowerCase();
            const buffer = typeof Buffer !== "undefined" ? Buffer.from(match[2], "base64") : null;
            return finalizePayload(buffer, mimeType, filename);
        }

        if (/^https?:\/\//i.test(src)) {
            const remote = await this.fetchRemoteImageBuffer(src);
            if (!remote || !remote.buffer || !remote.buffer.length) return null;
            return finalizePayload(remote.buffer, remote.mimeType, filename);
        }

        // 本地思源 assets/... 资源：规范化路径并严格限制在 assets/ 目录内（防 ../ 穿越）
        const rawRel = (imgItem.relPath || src).replace(/\\/g, "/").replace(/^(?:\.+\/)+/, "").replace(/^\/+/, "");
        const segments = rawRel.split("/").filter(Boolean);
        if (segments[0] !== "assets" || segments.includes("..")) {
            console.warn("[Metrix] 非法本地资源路径，已拦截:", src);
            return null;
        }
        const cleanRel = segments.join("/");

        try {
            const apiRes = await fetch("/api/file/getFile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: "/data/" + cleanRel })
            });
            if (apiRes.ok) {
                const ct = (apiRes.headers.get("content-type") || "").toLowerCase();
                if (!ct.includes("application/json")) {
                    const arrBuf = await apiRes.arrayBuffer();
                    if (arrBuf && arrBuf.byteLength > 0) {
                        const buf = typeof Buffer !== "undefined" ? Buffer.from(arrBuf) : new Uint8Array(arrBuf);
                        const mimeType = ct.startsWith("image/") ? ct.split(";")[0].trim() : this.guessMimeFromName(cleanRel);
                        return finalizePayload(buf, mimeType, filename);
                    }
                }
            }
        } catch (e) {}

        if (fs && path && dataDir) {
            try {
                const assetsRoot = path.resolve(dataDir, "assets");
                const diskPath = path.resolve(dataDir, cleanRel);
                if (diskPath.startsWith(assetsRoot + path.sep) && fs.existsSync(diskPath)) {
                    const buf = fs.readFileSync(diskPath);
                    if (buf && buf.length > 0) {
                        const mimeType = this.guessMimeFromName(diskPath);
                        return finalizePayload(buf, mimeType, filename);
                    }
                }
            } catch (e) {}
        }

        try {
            const staticRes = await fetch("/" + cleanRel);
            if (staticRes.ok) {
                const arrBuf = await staticRes.arrayBuffer();
                if (arrBuf && arrBuf.byteLength > 0) {
                    const ct = (staticRes.headers.get("content-type") || "").toLowerCase();
                    const buf = typeof Buffer !== "undefined" ? Buffer.from(arrBuf) : new Uint8Array(arrBuf);
                    const mimeType = ct.startsWith("image/") ? ct.split(";")[0].trim() : this.guessMimeFromName(cleanRel);
                    return finalizePayload(buf, mimeType, filename);
                }
            }
        } catch (e) {}

        return null;
    }

    static async renderToSelfContainedMarkdown(markdown, dataDir = "") {
        if (!markdown) return "";
        const localImgRegex = /!\[([^\]]*)\]\((\.?[\\/]?assets\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
        const matches = [];
        let m;
        while ((m = localImgRegex.exec(markdown)) !== null) {
            matches.push({ full: m[0], alt: m[1], relPath: m[2] });
        }
        let resMd = markdown;
        for (const item of matches) {
            try {
                const base64 = await this.resolveAssetBase64(item.relPath, dataDir);
                if (base64) {
                    const isGeneric = this.isGenericAlt(item.alt, item.relPath);
                    const cleanAlt = isGeneric ? "" : item.alt;
                    resMd = resMd.split(item.full).join(`![${cleanAlt}](${base64})`);
                }
            } catch (e) {}
        }
        return resMd;
    }

    static async renderToInlineHtml(markdown, dataDir = "") {
        if (!markdown) return "";
        let html = markdown;

        // 1. 保护代码块
        const codeBlocks = [];
        html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
            const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
            codeBlocks.push({ lang: lang || "terminal", code: code.trim() });
            return placeholder;
        });

        // 2. 转换本地 Markdown 相对路径图片为 Base64 内联图片
        const localImgRegex = /!\[([^\]]*)\]\((\.?[\\/]?assets\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
        const matches = [];
        let m;
        while ((m = localImgRegex.exec(html)) !== null) {
            matches.push({ full: m[0], alt: m[1], relPath: m[2] });
        }

        for (const item of matches) {
            try {
                const base64 = await this.resolveAssetBase64(item.relPath, dataDir);
                if (base64) {
                    const isGeneric = this.isGenericAlt(item.alt, item.relPath);
                    const cleanAlt = isGeneric ? "" : item.alt;
                    const altEscaped = this.escapeHtml(cleanAlt);
                    const captionHtml = !isGeneric && altEscaped ? `<span style="display: block; font-size: 13px; color: #64748b; margin-top: 8px; text-align: center;">${altEscaped}</span>` : "";
                    const imgCard = `<p style="margin: 24px 0; text-align: center;"><img src="${base64}" alt="${altEscaped}" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.08); display: inline-block;" />${captionHtml}</p>`;
                    html = html.split(item.full).join(imgCard);
                }
            } catch (err) {
                console.warn("[Metrix] 转存本地图片异常:", item.relPath, err);
            }
        }

        // 3. 转换可能存在的本地 <img> 标签
        const htmlLocalImgRegex = /<img[^>]+src=["'](\.?[\\/]?assets\/[^"'\s]+)["'][^>]*>/gi;
        const htmlMatches = [];
        let hm;
        while ((hm = htmlLocalImgRegex.exec(html)) !== null) {
            htmlMatches.push({ full: hm[0], relPath: hm[1] });
        }
        for (const item of htmlMatches) {
            try {
                const base64 = await this.resolveAssetBase64(item.relPath, dataDir);
                if (base64) {
                    html = html.split(item.full).join(`<p style="margin: 24px 0; text-align: center;"><img src="${base64}" alt="" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.08); display: inline-block;" /></p>`);
                }
            } catch (e) {}
        }

        // 4. 处理网络图片 ![alt](https://...)
        html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g, (full, alt, src) => {
            const isGeneric = this.isGenericAlt(alt, src);
            const cleanAlt = isGeneric ? "" : alt;
            const altEscaped = this.escapeHtml(cleanAlt);
            const captionHtml = !isGeneric && altEscaped ? `<span style="display: block; font-size: 13px; color: #64748b; margin-top: 8px; text-align: center;">${altEscaped}</span>` : "";
            return `<p style="margin: 24px 0; text-align: center;"><img src="${src}" alt="${altEscaped}" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.08); display: inline-block;" />${captionHtml}</p>`;
        });

        html = html.replace(/^### (.*$)/gim, `
            <div style="margin: 28px 0 14px 0; padding-left: 10px; border-left: 3.5px solid #0284c7; font-size: 16.5px; font-weight: bold; color: #0f172a; letter-spacing: 0.5px;">$1</div>
        `);
        html = html.replace(/^## (.*$)/gim, `
            <div style="margin: 36px 0 18px 0; font-size: 19px; font-weight: bold; color: #0f172a; display: flex; align-items: center;">
                <span style="display: inline-block; width: 6px; height: 18px; background: #0284c7; border-radius: 3px; margin-right: 8px;"></span><span>$1</span>
            </div>
        `);
        html = html.replace(/^# (.*$)/gim, `
            <div style="margin: 20px 0; text-align: center; font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1.4;">$1</div>
        `);
        html = html.replace(/(?:^>[ \t]?.*(?:\r?\n|$))+/gm, (block) => {
            const qLines = block
                .trim()
                .split(/\r?\n/)
                .map(l => l.replace(/^>[ \t]?/, "").trim())
                .filter(Boolean);
            if (!qLines.length) return "";
            return `\n\n<blockquote style="margin: 20px 0; padding: 14px 18px; background: #f8fafc; border-left: 4px solid #38bdf8; border-radius: 0 8px 8px 0; color: #334155; font-size: 14px; line-height: 1.75;">${qLines.join("<br/>")}</blockquote>\n\n`;
        });
        html = html.replace(/(?:^[ \t]*[-*+][ \t]+.+(?:\r?\n|$))+/gm, (block) => {
            const items = block
                .trim()
                .split(/\r?\n/)
                .map(l => l.replace(/^[ \t]*[-*+][ \t]+/, "").trim())
                .filter(Boolean)
                .map(it => `<li style="margin: 8px 0; line-height: 1.75;">${it}</li>`)
                .join("");
            return `\n\n<ul style="margin: 16px 0; padding-left: 22px; font-size: 15px; color: #334155;">${items}</ul>\n\n`;
        });
        html = html.replace(/(?:^[ \t]*\d+\.[ \t]+.+(?:\r?\n|$))+/gm, (block) => {
            const items = block
                .trim()
                .split(/\r?\n/)
                .map(l => l.replace(/^[ \t]*\d+\.[ \t]+/, "").trim())
                .filter(Boolean)
                .map(it => `<li style="margin: 8px 0; line-height: 1.75;">${it}</li>`)
                .join("");
            return `\n\n<ol style="margin: 16px 0; padding-left: 22px; font-size: 15px; color: #334155;">${items}</ol>\n\n`;
        });
        html = html.replace(/^---$/gim, `
            <div style="margin: 32px auto; height: 1px; background: #e2e8f0; width: 90%;"></div>
        `);
        html = html.replace(/\*\*(.*?)\*\*/g, `<strong style="color: #0f172a; font-weight: 700;">$1</strong>`);
        html = html.replace(/`([^`]+)`/g, `<code style="padding: 2px 6px; margin: 0 2px; background: #f1f5f9; color: #0284c7; border-radius: 4px; font-family: Menlo, Monaco, Consolas, monospace; font-size: 13.5px;">$1</code>`);

        codeBlocks.forEach((item, index) => {
            const escapedCode = this.escapeHtml(item.code);
            const macTerminalBlock = `
                <div style="margin: 24px 0; border-radius: 10px; overflow: hidden; background: #0b1120; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2); font-family: Menlo, Monaco, Consolas, 'Courier New', monospace;">
                    <div style="background: #1e293b; padding: 9px 14px; display: flex; align-items: center; justify-content: space-between;">
                        <div style="display: flex; gap: 7px;">
                            <span style="display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: #ff5f56;"></span>
                            <span style="display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: #ffbd2e;"></span>
                            <span style="display: inline-block; width: 11px; height: 11px; border-radius: 50%; background: #27c93f;"></span>
                        </div>
                        <span style="font-size: 11.5px; color: #94a3b8; text-transform: lowercase;">${item.lang || "bash"}</span>
                    </div>
                    <pre style="margin: 0; padding: 16px 18px; overflow-x: auto; font-size: 13.5px; line-height: 1.6; color: #e2e8f0; white-space: pre;"><code>${escapedCode}</code></pre>
                </div>
            `;
            html = html.replace(`__CODE_BLOCK_${index}__`, macTerminalBlock);
        });

        const paragraphs = html.split(/\n\s*\n/);
        const finalHtml = paragraphs.map(p => {
            const trimmed = p.trim();
            if (!trimmed) return "";
            if (/^<(?:div|pre|p|blockquote|ul|ol)\b/i.test(trimmed)) return trimmed;
            return `<p style="margin: 16px 0; font-size: 15px; line-height: 1.8; color: #334155; text-align: justify; letter-spacing: 0.3px;">${trimmed}</p>`;
        }).join("\n");

        return `<div style="max-width: 680px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; color: #334155;">${finalHtml}</div>`;
    }

    static formatSemanticInline(text) {
        if (!text) return "";
        const tokens = [];
        const saveToken = (htmlFrag) => {
            const tok = `\u0000TOK_${tokens.length}\u0000`;
            tokens.push(htmlFrag);
            return tok;
        };
        let s = text.replace(/`([^`]+)`/g, (_, c) => saveToken(`<code>${this.escapeHtml(c)}</code>`));
        s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
            const isGen = this.isGenericAlt(alt, src);
            const cleanAlt = isGen ? "" : this.escapeHtml(alt);
            return saveToken(`<img src="${this.escapeHtml(src)}" alt="${cleanAlt}" />`);
        });
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
            return saveToken(`<a href="${this.escapeHtml(url)}">${this.escapeHtml(label)}</a>`);
        });
        s = this.escapeHtml(s);
        s = s.replace(/\*\*([^*]+)\*\*/g, `<strong>$1</strong>`);
        s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, `$1<em>$2</em>`);
        s = s.replace(/\u0000TOK_(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] || "");
        return s;
    }

    /**
     * 生成面向知乎 / B站专栏 / 今日头条 / 飞书等富文本编辑器的标准语义化 HTML
     * 确保 <blockquote>、<h2>/<h3>、<ul>/<ol>、<pre><code>、<hr>、<img> 被各平台编辑器 100% 原生识别
     */
    static async renderToSemanticHtml(markdown, dataDir = "") {
        if (!markdown) return "";
        let md = markdown.replace(/\r\n/g, "\n");

        // 1. 提取代码块占位
        const codeBlocks = [];
        md = md.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push({ lang: (lang || "").trim(), code: code.replace(/\n$/, "") });
            return `\n\n@@METRIX_SEM_CODE_${idx}@@\n\n`;
        });

        // 2. 若仍有未转存外链的本地 assets 图片，兜底转为 Base64
        const localImgRegex = /!\[([^\]]*)\]\((\.?[\\/]?assets\/[^)\s"]+)(?:\s+"[^"]*")?\)/g;
        const localMatches = [];
        let m;
        while ((m = localImgRegex.exec(md)) !== null) {
            localMatches.push({ full: m[0], alt: m[1], relPath: m[2] });
        }
        for (const item of localMatches) {
            try {
                const b64 = await this.resolveAssetBase64(item.relPath, dataDir);
                if (b64) {
                    const cleanAlt = this.isGenericAlt(item.alt, item.relPath) ? "" : item.alt;
                    md = md.split(item.full).join(`![${cleanAlt}](${b64})`);
                }
            } catch (e) {}
        }

        const lines = md.split("\n");
        const out = [];
        let i = 0;

        while (i < lines.length) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();

            if (!trimmed) {
                i++;
                continue;
            }

            // 代码块占位
            const codeMatch = trimmed.match(/^@@METRIX_SEM_CODE_(\d+)@@$/);
            if (codeMatch) {
                const cb = codeBlocks[Number(codeMatch[1])];
                if (cb) {
                    const langAttr = cb.lang ? ` class="language-${this.escapeHtml(cb.lang)}"` : "";
                    out.push(`<pre><code${langAttr}>${this.escapeHtml(cb.code)}</code></pre>`);
                }
                i++;
                continue;
            }

            // 分割线
            if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
                out.push(`<hr />`);
                i++;
                continue;
            }

            // 标题 H1~H4
            const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
            if (hMatch) {
                const lvl = hMatch[1].length;
                out.push(`<h${lvl}>${this.formatSemanticInline(hMatch[2].trim())}</h${lvl}>`);
                i++;
                continue;
            }

            // 独立图片行
            const imgMatch = trimmed.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)(?:\s+"[^"]*")?\)$/);
            if (imgMatch) {
                const altRaw = imgMatch[1] || "";
                const src = imgMatch[2];
                const cleanAlt = this.isGenericAlt(altRaw, src) ? "" : this.escapeHtml(altRaw);
                out.push(`<p><img src="${src}" alt="${cleanAlt}" /></p>`);
                i++;
                continue;
            }

            // 引用块（连续 > 行合并为同一个原生 <blockquote>，内部换行用 <br />，兼容知乎 DraftJS 与 ProseMirror）
            if (/^>\s?/.test(trimmed)) {
                const qLines = [];
                while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
                    const qText = lines[i].trim().replace(/^>\s?/, "").trim();
                    if (qText) {
                        qLines.push(this.formatSemanticInline(qText));
                    }
                    i++;
                }
                if (qLines.length > 0) {
                    out.push(`<blockquote>${qLines.join("<br />")}</blockquote>`);
                }
                continue;
            }

            // 无序列表
            if (/^[-*+]\s+/.test(trimmed)) {
                const items = [];
                while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
                    const itemTxt = lines[i].trim().replace(/^[-*+]\s+/, "").trim();
                    items.push(`<li>${this.formatSemanticInline(itemTxt)}</li>`);
                    i++;
                }
                out.push(`<ul>${items.join("")}</ul>`);
                continue;
            }

            // 有序列表
            if (/^\d+\.\s+/.test(trimmed)) {
                const items = [];
                while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
                    const itemTxt = lines[i].trim().replace(/^\d+\.\s+/, "").trim();
                    items.push(`<li>${this.formatSemanticInline(itemTxt)}</li>`);
                    i++;
                }
                out.push(`<ol>${items.join("")}</ol>`);
                continue;
            }

            // 普通段落
            const pLines = [];
            while (
                i < lines.length &&
                lines[i].trim() &&
                !/^(?:@@METRIX_SEM_CODE_\d+@@|---|\*\*\*|___|#{1,4}\s+|>\s?|[-*+]\s+|\d+\.\s+|!\[[^\]]*\]\((?:https?:\/\/|data:image\/))/.test(lines[i].trim())
            ) {
                pLines.push(this.formatSemanticInline(lines[i].trim()));
                i++;
            }
            if (pLines.length > 0) {
                out.push(`<p>${pLines.join("<br />")}</p>`);
            } else {
                i++;
            }
        }

        return out.join("\n");
    }

    static escapeHtml(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }
}

/**
 * 5. LicenseManager: 基于 Ed25519 非对称数字签名的离线授权校验中心
 * 客户端仅内置公钥 (Public Key)，绝不包含私钥或生成逻辑，杜绝逆向算号与伪造
 */
class LicenseManager {
    static PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAb9NSWKk5qMrL7PVImBr5epX93uFzyRhk5uEqIQSKwpw=
-----END PUBLIC KEY-----`;

    static PUBLIC_KEY_SPKI_B64 = "MCowBQYDK2VwAyEAb9NSWKk5qMrL7PVImBr5epX93uFzyRhk5uEqIQSKwpw=";

    static base64UrlToUint8Array(b64url) {
        const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
        if (typeof Buffer !== "undefined") {
            return new Uint8Array(Buffer.from(b64, "base64"));
        }
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }

    static parseKey(key) {
        if (!key || typeof key !== "string") return null;
        const trimmed = key.trim();
        const match = trimmed.match(/^MXP2-(PRO|TEAM)-([A-Z2-9]{6,16})-([A-Za-z0-9_-]{86})$/);
        if (!match) return null;
        return {
            edition: match[1],
            serial: match[2],
            sigB64Url: match[3]
        };
    }

    static verifyKeyInfo(key) {
        const parsed = this.parseKey(key);
        if (!parsed) return { valid: false, edition: "FREE", serial: "" };

        if (nodeCrypto && typeof nodeCrypto.verify === "function") {
            try {
                const msgBuf = Buffer.from(`METRIX_V2|${parsed.edition}|${parsed.serial}`, "utf8");
                const sigBuf = Buffer.from(parsed.sigB64Url, "base64url");
                if (sigBuf.length !== 64) return { valid: false, edition: "FREE", serial: "" };
                const ok = nodeCrypto.verify(null, msgBuf, this.PUBLIC_KEY_PEM, sigBuf);
                if (ok) {
                    return { valid: true, edition: parsed.edition, serial: parsed.serial };
                }
            } catch (e) {
                console.warn("[Metrix] Ed25519 同步校验提示:", e);
            }
        }
        return { valid: false, edition: "FREE", serial: "" };
    }

    static async verifyKeyInfoAsync(key) {
        const syncRes = this.verifyKeyInfo(key);
        if (syncRes.valid) return syncRes;

        const parsed = this.parseKey(key);
        if (!parsed) return { valid: false, edition: "FREE", serial: "" };

        if (typeof crypto !== "undefined" && crypto.subtle) {
            try {
                const spkiBytes = this.base64UrlToUint8Array(this.PUBLIC_KEY_SPKI_B64);
                const pubKey = await crypto.subtle.importKey(
                    "spki",
                    spkiBytes.buffer,
                    { name: "Ed25519" },
                    false,
                    ["verify"]
                );
                const msgBytes = new TextEncoder().encode(`METRIX_V2|${parsed.edition}|${parsed.serial}`);
                const sigBytes = this.base64UrlToUint8Array(parsed.sigB64Url);
                if (sigBytes.byteLength !== 64) return { valid: false, edition: "FREE", serial: "" };
                const ok = await crypto.subtle.verify("Ed25519", pubKey, sigBytes, msgBytes);
                if (ok) {
                    return { valid: true, edition: parsed.edition, serial: parsed.serial };
                }
            } catch (e) {
                console.warn("[Metrix] WebCrypto Ed25519 校验提示:", e);
            }
        }
        return { valid: false, edition: "FREE", serial: "" };
    }

    static verifyKey(key) {
        return this.verifyKeyInfo(key).valid;
    }
}

/**
 * 5.5 WeChatOfficialApi: 微信公众号官方草稿箱 API 直连引擎 (AppID + AppSecret)
 * 采用 Node.js 原生 https (agent: false 绕过系统代理防动态 IP 触发 40164 白名单报错) + 思源内核 forwardProxy 双通道兜底
 */
class WeChatOfficialApi {
    static tokenCache = {
        appId: "",
        accessToken: "",
        expiresAt: 0
    };

    static formatWeChatError(errcode, errmsg = "") {
        const msg = String(errmsg || "unknown error");
        if (errcode === 40164) {
            const ipMatch = msg.match(/invalid ip\s+([0-9a-fA-F.:]+)/i);
            const ipHint = ipMatch ? `（检测到出口 IP: ${ipMatch[1]}）` : "";
            return `IP 白名单拦截 [40164]${ipHint}：请前往「微信公众平台 -> 设置与开发 -> 基本配置 -> IP白名单」添加本机公网 IP`;
        }
        if (errcode === 40013) return "AppID 无效 [40013]：请检查公众号 AppID 是否填写正确（如 wx 开头 18 位字符）";
        if (errcode === 40125 || errcode === 40001) return `AppSecret 校验失败 [${errcode}]：请检查开发者密码是否与后台一致`;
        if (errcode === 48001) return "接口未授权 [48001]：当前公众号暂未开通素材或草稿箱 API 权限";
        if (errcode === 45009) return "接口调用频次超限 [45009]：已达微信公众平台日调用上限";
        return `微信公众平台接口返回错误 [${errcode}]: ${msg}`;
    }

    static requestRaw({ method = "GET", apiPath, headers = {}, bodyBuffer = null, timeoutMs = 30000 }) {
        // 优先走 Node 原生 https 直连（无视浏览器 CORS 且强制 agent:false 旁路本地 VPN 代理）
        if (https) {
            return new Promise((resolve, reject) => {
                const reqHeaders = Object.assign({}, headers);
                if (bodyBuffer) {
                    reqHeaders["Content-Length"] = bodyBuffer.length;
                }
                const req = https.request(
                    {
                        hostname: "api.weixin.qq.com",
                        port: 443,
                        path: apiPath,
                        method,
                        headers: reqHeaders,
                        agent: false
                    },
                    (res) => {
                        const chunks = [];
                        res.on("data", (c) => chunks.push(c));
                        res.on("end", () => {
                            const rawText = Buffer.concat(chunks).toString("utf8");
                            try {
                                resolve(JSON.parse(rawText));
                            } catch (e) {
                                reject(new Error(`微信接口响应解析异常: ${rawText.slice(0, 180)}`));
                            }
                        });
                    }
                );
                req.setTimeout(timeoutMs, () => {
                    req.destroy(new Error("请求微信官方服务器超时，请检查网络连接"));
                });
                req.on("error", (err) => reject(err));
                if (bodyBuffer) req.write(bodyBuffer);
                req.end();
            });
        }

        // 浏览器窗口模式降级：对非二进制请求调用思源内核 forwardProxy
        return (async () => {
            const targetUrl = `https://api.weixin.qq.com${apiPath}`;
            const headerList = Object.entries(headers).map(([k, v]) => ({ [k]: v }));
            const proxyRes = await fetch("/api/network/forwardProxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: targetUrl,
                    method,
                    timeout: timeoutMs,
                    contentType: headers["Content-Type"] || "application/json",
                    headers: headerList,
                    payload: bodyBuffer ? bodyBuffer.toString("utf8") : ""
                })
            });
            const proxyJson = await proxyRes.json();
            const rawBody = proxyJson?.data?.body || "";
            return JSON.parse(rawBody);
        })();
    }

    static buildMultipartBuffer(fileBuffer, filename = "cover.png", mimeType = "image/png", fieldName = "media") {
        const boundary = "----MetrixWeChatForm" + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
        const safeName = String(filename || "image.png").replace(/["\r\n]/g, "_");
        const head = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`,
            "utf8"
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
        return {
            boundary,
            bodyBuffer: Buffer.concat([head, Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer), tail])
        };
    }

    static async getAccessToken(appId, appSecret, forceRefresh = false) {
        const cleanId = String(appId || "").trim();
        const cleanSecret = String(appSecret || "").trim();
        if (!cleanId || !cleanSecret) {
            throw new Error("请先在「设置 -> 微信公众号」填写 AppID 与 AppSecret");
        }

        const nowSec = Math.floor(Date.now() / 1000);
        if (
            !forceRefresh &&
            this.tokenCache.appId === cleanId &&
            this.tokenCache.accessToken &&
            this.tokenCache.expiresAt > nowSec + 120
        ) {
            return this.tokenCache.accessToken;
        }

        const q = `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cleanId)}&secret=${encodeURIComponent(cleanSecret)}`;
        const resp = await this.requestRaw({ method: "GET", apiPath: q });
        if (!resp || !resp.access_token) {
            throw new Error(this.formatWeChatError(resp?.errcode ?? -1, resp?.errmsg));
        }

        const expiresIn = Number(resp.expires_in) || 7200;
        this.tokenCache = {
            appId: cleanId,
            accessToken: resp.access_token,
            expiresAt: nowSec + expiresIn
        };
        return resp.access_token;
    }

    static async uploadPermanentImage(token, imageBuffer, filename = "cover.png", mimeType = "image/png") {
        if (!https || typeof Buffer === "undefined") {
            throw new Error("当前运行环境不支持二进制素材直传，请在思源桌面端使用微信公众号直连");
        }
        const safeMime = mimeType === "image/jpg" ? "image/jpeg" : (mimeType || "image/png");
        const { boundary, bodyBuffer } = this.buildMultipartBuffer(imageBuffer, filename || "image.png", safeMime, "media");
        const resp = await this.requestRaw({
            method: "POST",
            apiPath: `/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            bodyBuffer,
            timeoutMs: 40000
        });
        if (!resp || !resp.media_id) {
            const err = new Error(this.formatWeChatError(resp?.errcode ?? -1, resp?.errmsg || "图片素材上传失败"));
            err.errcode = resp?.errcode;
            throw err;
        }
        return resp.media_id;
    }

    static async uploadPermanentCover(token, coverBuffer) {
        return this.uploadPermanentImage(token, coverBuffer, "cover.png", "image/png");
    }

    static async uploadContentImage(token, imgBuffer, ext = "png") {
        const cleanExt = ext === "jpg" ? "jpeg" : (ext || "png");
        const mimeType = `image/${cleanExt}`;
        const { boundary, bodyBuffer } = this.buildMultipartBuffer(imgBuffer, `article_img.${ext || "png"}`, mimeType, "media");
        const resp = await this.requestRaw({
            method: "POST",
            apiPath: `/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`,
            headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
            bodyBuffer,
            timeoutMs: 40000
        });
        if (resp && resp.url) {
            return resp.url;
        }
        throw new Error(this.formatWeChatError(resp?.errcode ?? -1, resp?.errmsg || "正文图片上传失败"));
    }

    static async sanitizeHtmlImagesForWeChat(html, token) {
        if (!html || typeof Buffer === "undefined") return html;
        const dataImgRegex = /(<img[^>]+src=["'])(data:image\/([a-zA-Z0-9+]+);base64,([^"']+))(["'][^>]*>)/gi;
        const matches = [];
        let m;
        while ((m = dataImgRegex.exec(html)) !== null) {
            matches.push({
                fullDataUri: m[2],
                ext: (m[3] || "png").replace("+xml", ""),
                b64: m[4]
            });
        }
        let outHtml = html;
        for (const item of matches) {
            try {
                if (item.ext.toLowerCase() === "svg") continue;
                const buf = Buffer.from(item.b64, "base64");
                const wxUrl = await this.uploadContentImage(token, buf, item.ext);
                if (wxUrl) {
                    outHtml = outHtml.split(item.fullDataUri).join(wxUrl);
                }
            } catch (e) {
                console.warn("[Metrix] 公众号正文内嵌图上传跳过:", e);
            }
        }

        // 转存非微信官方域名的外链图片，避免公众号草稿箱防盗链过滤
        const remoteImgRegex = /<img[^>]+src=["'](https?:\/\/[^"'\s]+)["'][^>]*>/gi;
        const remoteUrls = new Set();
        let rm;
        while ((rm = remoteImgRegex.exec(outHtml)) !== null) {
            const url = rm[1];
            if (url && !/qpic\.cn|qlogo\.cn|weixin\.qq\.com/i.test(url)) {
                remoteUrls.add(url);
            }
        }
        for (const remoteUrl of remoteUrls) {
            try {
                if (typeof fetch === "function") {
                    const r = await fetch(remoteUrl);
                    if (r.ok) {
                        const ct = (r.headers.get("content-type") || "image/png").toLowerCase();
                        if (!ct.includes("svg")) {
                            const ext = ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : "png";
                            const arrBuf = await r.arrayBuffer();
                            const wxUrl = await this.uploadContentImage(token, Buffer.from(arrBuf), ext);
                            if (wxUrl) {
                                outHtml = outHtml.split(remoteUrl).join(wxUrl);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("[Metrix] 公众号外链图片转存跳过:", remoteUrl, e);
            }
        }
        return outHtml;
    }

    static sliceCodePoints(str, maxLen) {
        return Array.from(String(str || "").trim()).slice(0, maxLen).join("");
    }

    static async publishDraft({ appId, appSecret, title, author, digest, contentHtml, coverBuffer, onStep }) {
        const runOnce = async (forceRefreshToken = false) => {
            if (onStep) onStep("⏳ 鉴权中...");
            const token = await this.getAccessToken(appId, appSecret, forceRefreshToken);

            if (onStep) onStep("⏳ 上传封面...");
            const thumbMediaId = await this.uploadPermanentCover(token, coverBuffer);

            if (onStep) onStep("⏳ 同步配图...");
            const cleanHtml = await this.sanitizeHtmlImagesForWeChat(contentHtml, token);

            if (onStep) onStep("⏳ 写入草稿...");
            const article = {
                title: this.sliceCodePoints(title, 64) || "未命名文章",
                author: this.sliceCodePoints(author || "", 8),
                digest: this.sliceCodePoints(digest || "", 120),
                content: cleanHtml,
                thumb_media_id: thumbMediaId,
                need_open_comment: 1,
                only_fans_can_comment: 0
            };
            const payloadBuf = Buffer.from(JSON.stringify({ articles: [article] }), "utf8");
            const draftResp = await this.requestRaw({
                method: "POST",
                apiPath: `/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
                headers: { "Content-Type": "application/json; charset=utf-8" },
                bodyBuffer: payloadBuf,
                timeoutMs: 35000
            });
            if (!draftResp || !draftResp.media_id) {
                const err = new Error(this.formatWeChatError(draftResp?.errcode ?? -1, draftResp?.errmsg || "写入草稿箱失败"));
                err.errcode = draftResp?.errcode;
                throw err;
            }
            return { mediaId: draftResp.media_id };
        };

        try {
            return await runOnce(false);
        } catch (err) {
            if (err && (err.errcode === 40001 || err.errcode === 42001)) {
                return await runOnce(true);
            }
            throw err;
        }
    }

    /**
     * 清洗 Markdown 为微信小绿书 (newspic) 纯文本内容，保留段落换行与 #话题标签，截断 <= 1000 字
     */
    static formatNewspicContent(markdown = "", title = "") {
        let text = String(markdown || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/^---[\r\n]+[\s\S]*?[\r\n]+---[\r\n]*/, "");
        text = text.replace(/!\[[^\]]*\]\([^)]+\)\s*/g, "");
        text = text.replace(/<img\b[^>]*>\s*/gi, "");
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (label && label.trim() ? `${label.trim()} (${url})` : url));
        text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        text = text.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, "$1");
        text = text.replace(/^#{1,6}[ \t]+/gm, "");
        text = text.replace(/^>[ \t]?/gm, "");
        text = text.replace(/^(?:---|\*\*\*|___)$/gm, "");
        text = text.replace(/(\*\*|__|~~|`)/g, "");
        text = text.replace(/\u200b/g, "");

        const normTitle = String(title || "").replace(/\s+/g, " ").trim();
        const lines = text.split("\n").map(l => l.trimEnd());
        if (lines.length > 0 && normTitle && lines[0].trim().replace(/\s+/g, " ") === normTitle) {
            lines.shift();
        }
        let cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
        if (!cleaned) cleaned = normTitle || "图文分享";
        return this.sliceCodePoints(cleaned, 1000);
    }

    static isCommentPermissionError(resp) {
        if (!resp || resp.errcode === undefined || resp.errcode === 0) return false;
        const code = Number(resp.errcode);
        const errmsg = String(resp.errmsg || "").toLowerCase();
        const commentCodes = new Set([40097, 45008, 45065, 45083, 45157, 48001, 61450, 85079, 85080, 88000, 88001, 88002, 88003, 88004, 88005]);
        return commentCodes.has(code) || /comment|only_fans|留言|评论|privilege/.test(errmsg);
    }

    /**
     * 微信小绿书 (article_type: "newspic") 官方草稿箱直推
     */
    static async publishNewspicDraft({ appId, appSecret, title, author, contentText, images = [], onStep }) {
        if (!Array.isArray(images) || images.length === 0) {
            throw new Error("小绿书草稿至少需要 1 张图片素材");
        }
        const safeImages = images.slice(0, 20);
        const safeTitle = this.sliceCodePoints(title, 32) || "图文动态";
        const safeAuthor = this.sliceCodePoints(author || "", 8);
        const safeContent = this.sliceCodePoints(contentText || safeTitle, 1000);

        const imageMediaIds = new Array(safeImages.length).fill(null);

        const runOnce = async (forceRefreshToken = false) => {
            if (onStep) onStep("⏳ 鉴权中...");
            const token = await this.getAccessToken(appId, appSecret, forceRefreshToken);

            // 断点续传式上传永久素材：token 刷新后仅补传尚未拿到的 media_id，绝不重复上传
            for (let i = 0; i < safeImages.length; i++) {
                if (imageMediaIds[i]) continue;
                const img = safeImages[i];
                if (onStep) onStep(`⏳ 上传图 ${i + 1}/${safeImages.length}`);
                imageMediaIds[i] = await this.uploadPermanentImage(
                    token,
                    img.buffer,
                    img.filename || `newspic_${i + 1}.${img.ext || "png"}`,
                    img.mimeType || "image/png"
                );
            }

            const submitDraft = async (needOpenComment) => {
                const article = {
                    article_type: "newspic",
                    title: safeTitle,
                    author: safeAuthor,
                    content: safeContent,
                    image_info: {
                        image_list: imageMediaIds.map(mid => ({ image_media_id: mid }))
                    },
                    need_open_comment: needOpenComment,
                    only_fans_can_comment: 0
                };
                const payloadBuf = Buffer.from(JSON.stringify({ articles: [article] }), "utf8");
                return this.requestRaw({
                    method: "POST",
                    apiPath: `/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
                    headers: { "Content-Type": "application/json; charset=utf-8" },
                    bodyBuffer: payloadBuf,
                    timeoutMs: 35000
                });
            };

            if (onStep) onStep("⏳ 写入小绿书...");
            let draftResp = await submitDraft(1);
            if ((!draftResp || !draftResp.media_id) && this.isCommentPermissionError(draftResp)) {
                if (onStep) onStep("⏳ 降级重试...");
                draftResp = await submitDraft(0);
            }

            if (!draftResp || !draftResp.media_id) {
                const err = new Error(this.formatWeChatError(draftResp?.errcode ?? -1, draftResp?.errmsg || "写入小绿书草稿箱失败"));
                err.errcode = draftResp?.errcode;
                throw err;
            }
            return { mediaId: draftResp.media_id, imageCount: imageMediaIds.length };
        };

        try {
            return await runOnce(false);
        } catch (err) {
            if (err && (err.errcode === 40001 || err.errcode === 42001)) {
                return await runOnce(true);
            }
            throw err;
        }
    }
}

const DEFAULT_CONFIG = {
    author: "技术专栏作者",
    capsule: FREE_DEFAULT_CAPSULE,
    tags: "技术, 生产力, 架构",
    port: 18999,
    xhsMode: "safe_assist",
    licenseKey: "",
    licenseVerifiedEdition: "FREE",
    wechatMp: {
        appId: "",
        appSecret: ""
    },
    dailyUsage: {
        date: "",
        count: 0
    },
    imageBed: {
        type: "none",
        picgoUrl: "http://127.0.0.1:36677/upload",
        githubRepo: "",
        githubToken: "",
        imgbbKey: ""
    }
};

/**
 * 6. MetrixPlugin 主类 (商用专业版)
 */
class MetrixPlugin extends siyuan.Plugin {
    constructor(options) {
        super(options);
        this.config = Object.assign({}, DEFAULT_CONFIG);
        this.bridgeServer = new MatrixBridgeServer(18999);
        this.currentDocId = null;
        this.currentDocTitle = "";
    }

    async onload() {
        console.log("[Metrix] Starting Metrix Commercial Plugin v2.3.0...");
        await this.loadConfig();

        // 启动时复核授权签名状态
        if (this.config.licenseKey) {
            const licRes = await LicenseManager.verifyKeyInfoAsync(this.config.licenseKey);
            this.config.licenseVerifiedEdition = licRes.valid ? licRes.edition : "FREE";
        } else {
            this.config.licenseVerifiedEdition = "FREE";
        }

        if (this.config.port && this.config.port !== 18999) {
            this.bridgeServer = new MatrixBridgeServer(this.config.port);
        }

        try {
            await this.bridgeServer.start();
        } catch (e) {
            console.warn("[Metrix] Bridge server start notice:", e);
        }

        this.bridgeServer.onStatus((data) => {
            this.handleTaskStatusUpdate(data);
        });

        this.eventBus.on("switch-protyle", ({ detail }) => {
            if (detail?.protyle?.block?.rootID) {
                this.currentDocId = detail.protyle.block.rootID;
                const titleInput = detail.protyle.title?.element?.querySelector(".protyle-title__input") || detail.protyle.title?.element;
                this.currentDocTitle = (titleInput?.innerText || titleInput?.textContent || "").trim();
            }
        });

        this.eventBus.on("loaded-protyle-static", ({ detail }) => {
            if (detail?.protyle?.block?.rootID) {
                this.currentDocId = detail.protyle.block.rootID;
                const titleInput = detail.protyle.title?.element?.querySelector(".protyle-title__input") || detail.protyle.title?.element;
                this.currentDocTitle = (titleInput?.innerText || titleInput?.textContent || "").trim();
            }
        });

        this.addTopBar({
            icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2.5s4 3.5 4 8.5c0 2.2-.8 4.2-2 5.5v3.5l-2-1.5-2 1.5v-3.5c-1.2-1.3-2-3.3-2-5.5 0-5 4-8.5 4-8.5zm0 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 14s1.5.5 3 0l-1 3.5-2-3.5zm14 0s-1.5.5-3 0l1 3.5 2-3.5z"/></svg>`,
            title: "Metrix 矩阵一键分发",
            position: "right",
            callback: () => {
                this.openPublishDialog();
            }
        });

        this.addCommand({
            langKey: "metrixPublish",
            langText: "Metrix 矩阵多平台分发",
            hotkey: "⌥M",
            callback: () => {
                this.openPublishDialog();
            }
        });

        this.addCommand({
            langKey: "metrixSettings",
            langText: "Metrix 偏好设置",
            callback: () => {
                this.openSettingsDialog();
            }
        });

        this.addCommand({
            langKey: "metrixCompanion",
            langText: "Metrix 🧩 安装浏览器伴侣扩展",
            callback: () => {
                this.openCompanionGuideDialog();
            }
        });

        this.addCommand({
            langKey: "metrixActivate",
            langText: "Metrix 💎 专业版激活",
            callback: () => {
                this.openLicenseDialog();
            }
        });
    }

    onunload() {
        if (this.bridgeServer) {
            this.bridgeServer.stop();
        }
        console.log("[Metrix] Plugin unloaded.");
    }

    async loadConfig() {
        try {
            let stored = null;
            if (typeof this.loadData === "function") {
                stored = await this.loadData("config.json");
            }
            if (!stored && typeof localStorage !== "undefined") {
                const ls = localStorage.getItem("siyuan_metrix_config");
                if (ls) stored = JSON.parse(ls);
            }
            if (stored && typeof stored === "object") {
                this.config = Object.assign({}, DEFAULT_CONFIG, stored);
                if (stored.imageBed) {
                    this.config.imageBed = Object.assign({}, DEFAULT_CONFIG.imageBed, stored.imageBed);
                }
                if (stored.wechatMp) {
                    this.config.wechatMp = Object.assign({}, DEFAULT_CONFIG.wechatMp, stored.wechatMp);
                }
                if (stored.dailyUsage) {
                    this.config.dailyUsage = Object.assign({}, DEFAULT_CONFIG.dailyUsage, stored.dailyUsage);
                }
                if (this.config.xhsMode !== "human_auto") {
                    this.config.xhsMode = "safe_assist";
                }
            }
        } catch (e) {
            console.warn("[Metrix] 读取配置失败，采用默认值:", e);
        }
    }

    getLocalDateKey() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
    }

    getDailyUsageCount() {
        const today = this.getLocalDateKey();
        let cfgCount = 0;
        if (this.config?.dailyUsage?.date === today) {
            cfgCount = Number(this.config.dailyUsage.count) || 0;
        }
        let lsCount = 0;
        if (typeof localStorage !== "undefined") {
            try {
                const raw = localStorage.getItem("siyuan_metrix_daily_quota");
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed?.date === today) {
                        lsCount = Number(parsed.count) || 0;
                    }
                }
            } catch (e) {}
        }
        return Math.max(cfgCount, lsCount);
    }

    getRemainingFreeRuns() {
        return Math.max(0, FREE_DAILY_LIMIT - this.getDailyUsageCount());
    }

    async consumeFreeRun() {
        if (this.isPro()) return;
        const today = this.getLocalDateKey();
        const nextCount = this.getDailyUsageCount() + 1;
        const dailyUsage = { date: today, count: nextCount };
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem("siyuan_metrix_daily_quota", JSON.stringify(dailyUsage));
            } catch (e) {}
        }
        await this.saveConfig({ dailyUsage });
    }

    async saveConfig(newConfig) {
        this.config = Object.assign({}, this.config, newConfig);
        try {
            if (typeof this.saveData === "function") {
                await this.saveData("config.json", this.config);
            }
        } catch (e) {
            console.warn("[Metrix] saveData 失败:", e);
        }
        if (typeof localStorage !== "undefined") {
            try {
                localStorage.setItem("siyuan_metrix_config", JSON.stringify(this.config));
            } catch (e) {}
        }
    }

    getLicenseEdition() {
        const info = LicenseManager.verifyKeyInfo(this.config?.licenseKey);
        if (info.valid) return info.edition;
        if (this.config?.licenseKey && (this.config.licenseVerifiedEdition === "PRO" || this.config.licenseVerifiedEdition === "TEAM")) {
            return this.config.licenseVerifiedEdition;
        }
        return "FREE";
    }

    isPro() {
        const ed = this.getLicenseEdition();
        return ed === "PRO" || ed === "TEAM";
    }

    openCompanionGuideDialog() {
        const content = `
            <div class="metrix-settings-modal">
                <div class="metrix-settings-section">
                    <div class="metrix-section-title">🧩 30 秒安装「Metrix 浏览器发布伴侣」</div>
                    <div style="line-height: 1.7; color: var(--b3-theme-on-surface);">
                        Metrix 采用<strong>零封号风险架构</strong>：不伪造无头爬虫，直接复用您日常 Chrome / Edge 浏览器已登录的账号会话写入草稿箱（涵盖小红书、知乎、掘金、CSDN、头条、B站、飞书及海外 X / Threads；公众号长图文与小绿书直连官方 API）。首次使用只需安装一次伴侣扩展：
                    </div>
                    <ol style="margin: 4px 0 8px 18px; padding: 0; line-height: 1.85; color: var(--b3-theme-on-surface);">
                        <li>点击下方按钮，将内置的 <code>metrix-companion.zip</code> 导出到您的电脑并<strong>解压为文件夹</strong>；</li>
                        <li>打开 Chrome 或 Edge 浏览器扩展页（点击下方复制 <code>chrome://extensions/</code> 粘贴到地址栏回车），开启右上角<strong>「开发者模式」</strong>；</li>
                        <li>点击左上角<strong>「加载已解压的扩展程序」</strong>，选中刚才解压出来的文件夹即可永久生效！</li>
                    </ol>
                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                        <button id="metrix-btn-export-companion" class="metrix-btn-primary">📥 一键导出浏览器伴侣安装包 (.zip)</button>
                        <button id="metrix-btn-copy-ext-url" class="metrix-btn-secondary">📋 复制 chrome://extensions/</button>
                    </div>
                    <div id="metrix-companion-export-msg" style="font-size: 12px; color: #0284c7; min-height: 18px;"></div>
                </div>
            </div>
        `;

        new siyuan.Dialog({
            title: "🧩 安装 Metrix 浏览器伴侣扩展",
            content,
            width: "580px",
            height: "380px"
        });

        setTimeout(() => {
            const exportBtn = document.getElementById("metrix-btn-export-companion");
            const copyUrlBtn = document.getElementById("metrix-btn-copy-ext-url");
            const msgEl = document.getElementById("metrix-companion-export-msg");

            if (copyUrlBtn) {
                copyUrlBtn.onclick = () => {
                    navigator.clipboard.writeText("chrome://extensions/").then(() => {
                        siyuan.showMessage("✔ 已复制 chrome://extensions/，请粘贴至浏览器地址栏打开", 3000, "info");
                    });
                };
            }

            if (exportBtn) {
                exportBtn.onclick = async () => {
                    try {
                        const apiRes = await fetch("/api/file/getFile", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ path: "/data/plugins/siyuan-metrix/companion/metrix-companion.zip" })
                        });
                        if (!apiRes.ok) {
                            throw new Error("未找到内置扩展包文件");
                        }
                        const blob = await apiRes.blob();

                        if (fs && path && os) {
                            const downloadsDir = path.join(os.homedir(), "Downloads");
                            if (fs.existsSync(downloadsDir)) {
                                const targetZip = path.join(downloadsDir, "metrix-companion.zip");
                                const arrBuf = await blob.arrayBuffer();
                                fs.writeFileSync(targetZip, Buffer.from(arrBuf));
                                if (msgEl) {
                                    msgEl.innerHTML = `✔ 已导出至下载目录：<code>${this.escapeHtml(targetZip)}</code>（解压后加载即可）`;
                                }
                                siyuan.showMessage(`✔ 已保存至下载目录: ${targetZip}`, 4000, "info");
                                return;
                            }
                        }

                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = "metrix-companion.zip";
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                        if (msgEl) msgEl.innerText = "✔ 浏览器伴侣安装包下载已触发，解压后加载即可！";
                    } catch (err) {
                        console.error("[Metrix] 导出伴侣扩展失败:", err);
                        siyuan.showMessage("❌ 导出失败: " + err.message, 3500, "error");
                    }
                };
            }
        }, 30);
    }

    openSettingsDialog() {
        const cfg = this.config;
        const isPro = this.isPro();
        const edition = this.getLicenseEdition();
        const editionLabel = edition === "TEAM"
            ? "🏢 Metrix 工作室团队版 (已永久授权)"
            : (edition === "PRO" ? "💎 Metrix 终身专业版 (已永久授权)" : "Metrix 免费社区版");

        const proLockHint = !isPro ? `<span style="color:#d97706; font-weight:600; margin-left:6px;">[💎 专业版解锁自定义]</span>` : "";

        const content = `
            <div class="metrix-settings-modal">
                <div class="metrix-settings-section">
                    <div class="metrix-section-title">🟢 微信公众号官方草稿箱直连 (AppID & AppSecret)</div>
                    <div style="font-size:12px; line-height:1.6; color:var(--b3-theme-on-surface-light);">
                        前往「微信公众平台 → 设置与开发 → 基本配置」获取开发者凭证，并将本机外网 IP 添加至<strong>【IP白名单】</strong>，即可免浏览器一键将排版封面与图文直推公众号草稿箱。
                    </div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">开发者 ID (AppID)</label>
                        <input id="metrix-set-wx-appid" class="metrix-input" value="${this.escapeHtml(cfg.wechatMp?.appId || '')}" placeholder="例如：wx1234567890abcdef" />
                    </div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">开发者密码 (AppSecret)</label>
                        <div style="display:flex; gap:8px;">
                            <input id="metrix-set-wx-secret" type="password" class="metrix-input" value="${this.escapeHtml(cfg.wechatMp?.appSecret || '')}" placeholder="输入 32 位公众号开发者密码 (仅加密存储于本机)" />
                            <button id="metrix-set-btn-wx-test" class="metrix-btn-secondary" style="white-space:nowrap;">🔌 测试连接</button>
                        </div>
                        <div id="metrix-set-wx-msg" style="font-size:12px; min-height:16px; margin-top:2px;"></div>
                    </div>
                </div>

                <div class="metrix-settings-section">
                    <div class="metrix-section-title">👤 品牌与作者署名 ${proLockHint}</div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">默认作者署名</label>
                        <input id="metrix-set-author" class="metrix-input" value="${this.escapeHtml(isPro ? cfg.author : DEFAULT_CONFIG.author)}" ${!isPro ? 'readonly style="opacity:0.65; cursor:not-allowed;"' : ''} placeholder="例如：一缕82年的清风" />
                    </div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">封面顶部胶囊标语</label>
                        <input id="metrix-set-capsule" class="metrix-input" value="${this.escapeHtml(isPro ? cfg.capsule : FREE_DEFAULT_CAPSULE)}" ${!isPro ? 'readonly style="opacity:0.65; cursor:not-allowed;"' : ''} placeholder="例如：【深度技术剖析 · 生产实战】" />
                    </div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">默认发布文章标签 (逗号分隔)</label>
                        <input id="metrix-set-tags" class="metrix-input" value="${this.escapeHtml(cfg.tags)}" placeholder="例如：技术, 生产力, 架构" />
                    </div>
                </div>

                <div class="metrix-settings-section">
                    <div class="metrix-section-title">🖼️ 图床与外链策略 ${proLockHint}</div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">图片分发模式</label>
                        <select id="metrix-set-imgbed-type" class="metrix-select" ${!isPro ? 'disabled style="opacity:0.65; cursor:not-allowed;"' : ''}>
                            <option value="none" ${(isPro ? cfg.imageBed.type : 'none') === 'none' ? 'selected' : ''}>极客纯净流 (不依赖图床，纯代码块与Canvas封面，防外链拦截) - 推荐</option>
                            <option value="picgo" ${isPro && cfg.imageBed.type === 'picgo' ? 'selected' : ''}>PicGo 本地服务 (http://127.0.0.1:36677/upload) [Pro]</option>
                            <option value="imgbb" ${isPro && cfg.imageBed.type === 'imgbb' ? 'selected' : ''}>ImgBB 云端免费图床 (API Key 直连) [Pro]</option>
                            <option value="github" ${isPro && cfg.imageBed.type === 'github' ? 'selected' : ''}>GitHub + jsDelivr CDN 图床 (Repo + Token) [Pro]</option>
                        </select>
                    </div>
                    <div id="metrix-set-picgo-box" class="metrix-form-row" style="${isPro && cfg.imageBed.type === 'picgo' ? '' : 'display:none;'}">
                        <label class="metrix-field-label">PicGo 上传接口地址</label>
                        <input id="metrix-set-picgo-url" class="metrix-input" value="${this.escapeHtml(cfg.imageBed.picgoUrl || 'http://127.0.0.1:36677/upload')}" />
                    </div>
                    <div id="metrix-set-imgbb-box" class="metrix-form-row" style="${isPro && cfg.imageBed.type === 'imgbb' ? '' : 'display:none;'}">
                        <label class="metrix-field-label">ImgBB API Key (在 api.imgbb.com 免费获取)</label>
                        <input id="metrix-set-imgbb-key" class="metrix-input" value="${this.escapeHtml(cfg.imageBed.imgbbKey || '')}" placeholder="输入 32 位 ImgBB API Key" />
                    </div>
                    <div id="metrix-set-github-box" class="metrix-form-row" style="${isPro && cfg.imageBed.type === 'github' ? '' : 'display:none;'}">
                        <label class="metrix-field-label">GitHub 仓库 (owner/repo) 与 Personal Access Token</label>
                        <input id="metrix-set-gh-repo" class="metrix-input" style="margin-bottom:6px;" value="${this.escapeHtml(cfg.imageBed.githubRepo || '')}" placeholder="例如: yourname/blog-images" />
                        <input id="metrix-set-gh-token" class="metrix-input" type="password" value="${this.escapeHtml(cfg.imageBed.githubToken || '')}" placeholder="Personal Access Token (需 repo 权限)" />
                    </div>
                </div>

                <div class="metrix-settings-section">
                    <div class="metrix-section-title">📕 小红书图文防封号分发策略</div>
                    <div style="font-size:12px; line-height:1.6; color:var(--b3-theme-on-surface-light);">
                        默认采用 0 自动注入的悬浮接力台；如需自动上传与话题点选变蓝，可切换为拟人慢速填充模式（绝不自动点发布）。
                    </div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">小红书分发模式</label>
                        <select id="metrix-set-xhs-mode" class="metrix-select">
                            <option value="safe_assist" ${cfg.xhsMode !== 'human_auto' ? 'selected' : ''}>🛡️ 零风控接力模式（默认推荐 · 0自动注入不封号）</option>
                            <option value="human_auto" ${cfg.xhsMode === 'human_auto' ? 'selected' : ''}>⚡ 拟人慢速填充模式（随机停顿 + 话题自动变蓝）</option>
                        </select>
                    </div>
                </div>

                <div class="metrix-settings-section">
                    <div class="metrix-section-title">🌐 本地通信与浏览器伴侣</div>
                    <div class="metrix-form-row">
                        <label class="metrix-field-label">Bridge 服务端口 (默认 18999)</label>
                        <div style="display:flex; gap:10px; align-items:center;">
                            <input id="metrix-set-port" type="number" class="metrix-input" style="max-width: 180px;" value="${cfg.port || 18999}" />
                            <button id="metrix-set-btn-companion" class="metrix-btn-secondary">🧩 导出/安装浏览器伴侣扩展</button>
                        </div>
                    </div>
                </div>

                <div class="metrix-settings-section">
                    <div class="metrix-section-title">💎 授权与商业版状态</div>
                    <div style="display:flex; align-items:center; justify-content:space-between;">
                        <div>
                            当前版本：<strong>${editionLabel}</strong>
                        </div>
                        ${!isPro ? '<button id="metrix-set-btn-goto-pro" class="metrix-top-btn metrix-top-btn-pro">💎 升级专业版</button>' : ''}
                    </div>
                    <div class="metrix-form-row" style="margin-top: 8px;">
                        <label class="metrix-field-label">Ed25519 数字签名激活码</label>
                        <div style="display:flex; gap: 8px;">
                            <input id="metrix-set-license" class="metrix-input" value="${this.escapeHtml(cfg.licenseKey || '')}" placeholder="MXP2-PRO-XXXXXXXX-..." />
                            <button id="metrix-set-btn-verify-license" class="metrix-btn-secondary" style="white-space:nowrap;">验证签名</button>
                        </div>
                    </div>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:10px; margin-top: 6px;">
                    <button id="metrix-set-btn-save" class="metrix-btn-primary">💾 保存偏好设置</button>
                </div>
            </div>
        `;

        new siyuan.Dialog({
            title: "⚙️ Metrix 偏好设置",
            content: content,
            width: "620px",
            height: "640px"
        });

        setTimeout(() => {
            const typeSelect = document.getElementById("metrix-set-imgbed-type");
            const picgoBox = document.getElementById("metrix-set-picgo-box");
            const imgbbBox = document.getElementById("metrix-set-imgbb-box");
            const ghBox = document.getElementById("metrix-set-github-box");

            if (typeSelect) {
                typeSelect.onchange = () => {
                    const val = typeSelect.value;
                    if (picgoBox) picgoBox.style.display = val === "picgo" ? "flex" : "none";
                    if (imgbbBox) imgbbBox.style.display = val === "imgbb" ? "flex" : "none";
                    if (ghBox) ghBox.style.display = val === "github" ? "flex" : "none";
                };
            }

            const companionBtn = document.getElementById("metrix-set-btn-companion");
            if (companionBtn) {
                companionBtn.onclick = () => this.openCompanionGuideDialog();
            }

            const wxTestBtn = document.getElementById("metrix-set-btn-wx-test");
            const wxMsgEl = document.getElementById("metrix-set-wx-msg");
            if (wxTestBtn && wxMsgEl) {
                wxTestBtn.onclick = async () => {
                    const appId = document.getElementById("metrix-set-wx-appid")?.value?.trim() || "";
                    const appSecret = document.getElementById("metrix-set-wx-secret")?.value?.trim() || "";
                    if (!appId || !appSecret) {
                        wxMsgEl.innerHTML = `<span style="color:#ef4444;">请先填写完整的公众号 AppID 与 AppSecret</span>`;
                        return;
                    }
                    wxTestBtn.disabled = true;
                    wxMsgEl.innerHTML = `<span style="color:#0284c7;">⏳ 正在直连微信公众平台校验凭证与 IP 白名单...</span>`;
                    try {
                        await WeChatOfficialApi.getAccessToken(appId, appSecret, true);
                        wxMsgEl.innerHTML = `<span style="color:#22c55e; font-weight:600;">✔ 连接成功！AccessToken 获取正常，IP 白名单已放行</span>`;
                    } catch (err) {
                        wxMsgEl.innerHTML = `<span style="color:#ef4444;">❌ ${this.escapeHtml(err.message || String(err))}</span>`;
                    } finally {
                        wxTestBtn.disabled = false;
                    }
                };
            }

            const gotoProBtn = document.getElementById("metrix-set-btn-goto-pro");
            if (gotoProBtn) {
                gotoProBtn.onclick = () => this.openLicenseDialog();
            }

            const verifyLicBtn = document.getElementById("metrix-set-btn-verify-license");
            if (verifyLicBtn) {
                verifyLicBtn.onclick = async () => {
                    const licVal = document.getElementById("metrix-set-license")?.value?.trim() || "";
                    const res = await LicenseManager.verifyKeyInfoAsync(licVal);
                    if (res.valid) {
                        await this.saveConfig({ licenseKey: licVal, licenseVerifiedEdition: res.edition });
                        siyuan.showMessage(`✔ 数字签名校验通过！已激活 [${res.edition === "TEAM" ? "工作室团队版" : "终身专业版"}]，请重新打开设置面板解锁全部配置`, 3500, "info");
                    } else {
                        siyuan.showMessage("❌ 授权码签名无效或格式不匹配", 3000, "error");
                    }
                };
            }

            const saveBtn = document.getElementById("metrix-set-btn-save");
            if (saveBtn) {
                saveBtn.onclick = async () => {
                    const licVal = document.getElementById("metrix-set-license")?.value?.trim() || "";
                    let verifiedEd = "FREE";
                    if (licVal) {
                        const res = await LicenseManager.verifyKeyInfoAsync(licVal);
                        verifiedEd = res.valid ? res.edition : "FREE";
                    }
                    const nowPro = verifiedEd === "PRO" || verifiedEd === "TEAM";

                    const author = nowPro
                        ? (document.getElementById("metrix-set-author")?.value?.trim() || DEFAULT_CONFIG.author)
                        : DEFAULT_CONFIG.author;
                    const capsule = nowPro
                        ? (document.getElementById("metrix-set-capsule")?.value?.trim() || FREE_DEFAULT_CAPSULE)
                        : FREE_DEFAULT_CAPSULE;
                    const tags = document.getElementById("metrix-set-tags")?.value?.trim() || DEFAULT_CONFIG.tags;
                    const port = parseInt(document.getElementById("metrix-set-port")?.value, 10) || 18999;
                    const imgbedType = nowPro ? (document.getElementById("metrix-set-imgbed-type")?.value || "none") : "none";
                    const picgoUrl = document.getElementById("metrix-set-picgo-url")?.value?.trim() || "http://127.0.0.1:36677/upload";
                    const imgbbKey = document.getElementById("metrix-set-imgbb-key")?.value?.trim() || "";
                    const githubRepo = document.getElementById("metrix-set-gh-repo")?.value?.trim() || "";
                    const githubToken = document.getElementById("metrix-set-gh-token")?.value?.trim() || "";
                    const wxAppId = document.getElementById("metrix-set-wx-appid")?.value?.trim() || "";
                    const wxAppSecret = document.getElementById("metrix-set-wx-secret")?.value?.trim() || "";
                    const xhsMode = document.getElementById("metrix-set-xhs-mode")?.value === "human_auto" ? "human_auto" : "safe_assist";

                    await this.saveConfig({
                        author,
                        capsule,
                        tags,
                        port,
                        xhsMode,
                        licenseKey: licVal,
                        licenseVerifiedEdition: verifiedEd,
                        wechatMp: {
                            appId: wxAppId,
                            appSecret: wxAppSecret
                        },
                        imageBed: {
                            type: imgbedType,
                            picgoUrl,
                            imgbbKey,
                            githubRepo,
                            githubToken
                        }
                    });

                    const wxStatusBg = document.getElementById("status-wechat");
                    if (wxStatusBg && wxAppId && wxAppSecret) {
                        wxStatusBg.innerHTML = "⚪ 待发布";
                    }
                    const wxNewspicStatusBg = document.getElementById("status-wechat_newspic");
                    if (wxNewspicStatusBg && wxAppId && wxAppSecret) {
                        wxNewspicStatusBg.innerHTML = "⚪ 待发布";
                    }
                    const xhsRadio = document.querySelector(`input[name='metrix-xhs-mode'][value='${xhsMode}']`);
                    if (xhsRadio) {
                        xhsRadio.checked = true;
                        document.querySelectorAll(".metrix-xhs-mode-opt").forEach(el => {
                            el.classList.toggle("active", el.getAttribute("data-mode") === xhsMode);
                        });
                    }

                    siyuan.showMessage("✔ Metrix 偏好设置已成功保存！", 2500, "info");
                };
            }
        }, 30);
    }

    openLicenseDialog() {
        const content = `
            <div class="metrix-license-modal">
                <div style="text-align:center;">
                    <h2 style="margin:0 0 6px 0; font-size:20px; color:var(--b3-theme-on-surface);">💎 升级 Metrix 矩阵分发专业版</h2>
                    <div style="font-size:13px; color:var(--b3-theme-on-surface-light);">
                        一次买断 · 终身授权 · 公众号/小绿书直连 + 小红书双模 + 海内外 11 大渠道一键齐发
                    </div>
                </div>

                <div class="metrix-plan-grid">
                    <div class="metrix-plan-card">
                        <div class="metrix-plan-title">Metrix 免费社区版</div>
                        <div class="metrix-plan-price">¥0 <span style="font-size:12px; font-weight:normal; color:var(--b3-theme-on-surface-light);">永久免费</span></div>
                        <ul class="metrix-feature-list">
                            <li>✔ 单次发布 1 个平台（每日限 3 次）</li>
                            <li>✔ 支持公众号/小绿书直连 & 小红书/海内外社区</li>
                            <li>✔ 微信公众号极客蓝排版 & 3:4 自动分卡</li>
                            <li>✔ 原生 Canvas 2.35:1 封面渲染</li>
                            <li style="color:var(--b3-theme-on-surface-light); opacity:0.6;">✖ 全网 11 大渠道不限次数一键齐发</li>
                            <li style="color:var(--b3-theme-on-surface-light); opacity:0.6;">✖ 专栏胶囊标语与云图床深度定制</li>
                        </ul>
                    </div>

                    <div class="metrix-plan-card featured">
                        <div class="metrix-plan-tag">终身买断</div>
                        <div class="metrix-plan-title">💎 终身专业版 (Lifetime)</div>
                        <div class="metrix-plan-price gold">¥49 <span style="font-size:12px; font-weight:normal; color:var(--b3-theme-on-surface-light);">永久买断 / 团队版 ¥129</span></div>
                        <ul class="metrix-feature-list">
                            <li>✔ <strong>全网 11 大渠道（含小绿书/小红书/X/Threads）无限齐发</strong></li>
                            <li>✔ <strong>公众号长图文 & 小绿书 AppID 直推 + 海内外免密同步</strong></li>
                            <li>✔ <strong>专栏胶囊标语 & 品牌作者深度定制</strong></li>
                            <li>✔ <strong>PicGo / ImgBB / GitHub 图床极速直连</strong></li>
                            <li>✔ <strong>Ed25519 纯离线非对称验签，100% 隐私安全</strong></li>
                        </ul>
                    </div>
                </div>

                <div class="metrix-key-box">
                    <div class="metrix-field-label">输入正版数字签名激活码 (支持 PRO / TEAM 授权码)</div>
                    <div style="display:flex; gap:8px;">
                        <input id="metrix-license-input" class="metrix-input" placeholder="粘贴 MXP2-PRO-... 或 MXP2-TEAM-... 激活码" value="${this.escapeHtml(this.config.licenseKey || '')}" />
                        <button id="metrix-license-btn-submit" class="metrix-btn-primary" style="white-space:nowrap;">立即激活 💎</button>
                    </div>
                    <div id="metrix-license-msg" style="font-size:12px; margin-top:4px; min-height:16px;"></div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:12px;">
                        <a href="${PURCHASE_PRO_URL}" target="_blank" style="color:#0284c7; font-weight:600; text-decoration:none;">👉 前往爱发电购买正版激活码 (¥49 永久买断 · 自动发货)</a>
                        <span style="color:var(--b3-theme-on-surface-light);">纯离线公私钥验签 · 永不断联</span>
                    </div>
                </div>
            </div>
        `;

        new siyuan.Dialog({
            title: "",
            content: content,
            width: "640px",
            height: "560px"
        });

        setTimeout(() => {
            const submitBtn = document.getElementById("metrix-license-btn-submit");
            const inputEl = document.getElementById("metrix-license-input");
            const msgEl = document.getElementById("metrix-license-msg");

            if (submitBtn && inputEl && msgEl) {
                submitBtn.onclick = async () => {
                    const key = inputEl.value.trim();
                    if (!key) {
                        msgEl.innerHTML = `<span style="color:#ef4444;">请输入有效的正版激活码</span>`;
                        return;
                    }
                    const res = await LicenseManager.verifyKeyInfoAsync(key);
                    if (res.valid) {
                        await this.saveConfig({ licenseKey: key, licenseVerifiedEdition: res.edition });
                        const edName = res.edition === "TEAM" ? "工作室团队版" : "终身专业版";
                        msgEl.innerHTML = `<span style="color:#22c55e; font-weight:600;">🎉 恭喜！[${edName} · SN:${res.serial}] 激活成功，感谢支持正版！</span>`;
                        const badgeEl = document.getElementById("metrix-free-quota-badge");
                        if (badgeEl) {
                            badgeEl.className = "metrix-badge metrix-badge-pro";
                            badgeEl.innerText = res.edition === "TEAM" ? "🏢 团队版" : "💎 专业版";
                        }
                        const actBtn = document.getElementById("metrix-header-activate");
                        if (actBtn) actBtn.style.display = "none";
                        siyuan.showMessage(`🎉 恭喜！Metrix ${edName}已永久激活！`, 3500, "info");
                    } else {
                        msgEl.innerHTML = `<span style="color:#ef4444;">❌ 激活码数字签名校验未通过，请核对是否完整复制</span>`;
                    }
                };
            }
        }, 30);
    }

    async openPublishDialog() {
        let activeDoc = DocParser.getActiveDocFromDOM(this);
        let docId = activeDoc?.docId;
        let initialTitle = activeDoc?.title || "";

        siyuan.showMessage("正在解析文档并渲染封面...", 1500, "info");
        const docData = await DocParser.parseDocument(docId, initialTitle);
        if (!docData || !docData.markdown) {
            siyuan.showMessage("未能读取到文档内容，请先打开一篇文章", 4000, "error");
            return;
        }

        const isPro = this.isPro();
        const edition = this.getLicenseEdition();
        const defaultCapsule = isPro ? (this.config.capsule || FREE_DEFAULT_CAPSULE) : FREE_DEFAULT_CAPSULE;
        const coverCanvas = await CoverRenderer.renderWechatCover(docData.title, defaultCapsule);
        const coverDataURL = CoverRenderer.canvasToDataURL(coverCanvas);
        let coverBuffer = await CoverRenderer.canvasToBuffer(coverCanvas);
        let latestCoverPromise = Promise.resolve(coverBuffer);
        const inlineHtml = await ThemeEngine.renderToInlineHtml(docData.markdown, docData.dataDir);

        const hasWechatCreds = Boolean(this.config.wechatMp?.appId?.trim() && this.config.wechatMp?.appSecret?.trim());
        const checkWechatDefault = hasWechatCreds;
        const checkZhihuDefault = isPro ? true : !hasWechatCreds;
        const checkOtherDefault = isPro;

        const remainingFree = this.getRemainingFreeRuns();
        const badgeHtml = edition === "TEAM"
            ? '<span class="metrix-badge metrix-badge-pro">🏢 团队版</span>'
            : (isPro
                ? '<span class="metrix-badge metrix-badge-pro">💎 专业版</span>'
                : `<span id="metrix-free-quota-badge" class="metrix-badge metrix-badge-free">免费版 (单次1平台 · 今日余 ${remainingFree}/${FREE_DAILY_LIMIT}次)</span>`);

        const wechatStatusInit = hasWechatCreds
            ? '⚪ 待发布'
            : '<span id="metrix-wx-quick-cfg" style="color:#0284c7; text-decoration:underline; cursor:pointer;" title="点击配置公众号 AppID 与 AppSecret">⚙️ 配置密钥</span>';

        const newspicStatusInit = hasWechatCreds
            ? '⚪ 待发布'
            : '<span id="metrix-wx-newspic-quick-cfg" style="color:#0284c7; text-decoration:underline; cursor:pointer;" title="点击配置公众号 AppID 与 AppSecret">⚙️ 配置密钥</span>';

        const curXhsMode = this.config.xhsMode === "human_auto" ? "human_auto" : "safe_assist";

        const dialogContent = `
            <div class="metrix-dialog">
                <div class="metrix-header">
                    <div class="metrix-header-title">
                        <span>🚀 Metrix 矩阵分发控制台</span>
                        ${badgeHtml}
                    </div>
                    <div class="metrix-header-actions">
                        ${!isPro ? '<button id="metrix-header-activate" class="metrix-top-btn metrix-top-btn-pro">💎 升级专业版</button>' : ''}
                        <button id="metrix-header-companion" class="metrix-top-btn" title="导出与安装浏览器伴侣扩展">🧩 伴侣扩展</button>
                        <button id="metrix-header-settings" class="metrix-top-btn" title="偏好设置">⚙️ 设置</button>
                        <span style="font-size: 12px; color: var(--b3-theme-on-surface-light);">端口: ${this.bridgeServer.port}</span>
                    </div>
                </div>

                <div class="metrix-body">
                    <div class="metrix-left">
                        <div>
                            <div class="metrix-field-label">文章标题</div>
                            <input id="metrix-input-title" class="metrix-input" value="${this.escapeHtml(docData.title)}" />
                        </div>
                        <div>
                            <div class="metrix-field-label">
                                顶部胶囊标语 (作者 / 专栏品牌)
                                ${!isPro ? '<span id="metrix-capsule-pro-hint" style="color:#d97706; cursor:pointer; margin-left:6px;">🔒 升级 Pro 解锁自定义</span>' : ''}
                            </div>
                            <input id="metrix-input-capsule" class="metrix-input" value="${this.escapeHtml(defaultCapsule)}" ${!isPro ? 'readonly style="opacity:0.7; cursor:pointer;" title="点击升级专业版解锁自定义胶囊品牌标语"' : ''} />
                        </div>
                        <div>
                            <div class="metrix-field-label">摘要 (Digest)</div>
                            <textarea id="metrix-input-digest" class="metrix-input" rows="3" style="resize: vertical;">${this.escapeHtml(docData.digest)}</textarea>
                        </div>
                        <div>
                            <div class="metrix-field-label">Canvas 实时渲染封面 (2.35:1 / 900x383)</div>
                            <div class="metrix-cover-preview">
                                <img id="metrix-img-cover" src="${coverDataURL}" />
                            </div>
                        </div>
                    </div>

                    <div class="metrix-right">
                        <div class="metrix-field-label" style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">
                            <span>目标平台${!isPro ? ` <span id="metrix-label-upsell" style="font-weight:600; color:#d97706; cursor:pointer;" title="点击查看 Pro 终身版并发权益">(免费版单次选 1 平台 · 每日 ${FREE_DAILY_LIMIT} 次 · <span style="text-decoration:underline;">解锁 11 渠道齐发</span>)</span>` : '（11 大海内外全能分发渠道）'}</span>
                            ${isPro ? `<span class="metrix-preset-bar">
                                <button type="button" class="metrix-preset-btn" id="metrix-preset-long">长文9端</button>
                                <button type="button" class="metrix-preset-btn" id="metrix-preset-pic">图文双发</button>
                                <button type="button" class="metrix-preset-btn" id="metrix-preset-all">全选11端</button>
                            </span>` : ''}
                        </div>
                        <div class="metrix-platforms-grid">
                            <label class="metrix-platform-item ${checkWechatDefault ? 'active' : ''}" data-platform="wechat" style="grid-column: 1 / -1;">
                                <input type="checkbox" ${checkWechatDefault ? 'checked' : ''} value="wechat" style="accent-color: #16a34a;" />
                                <span style="font-weight: 600;">🟢 微信公众号</span>
                                <span style="font-size: 11px; padding: 1px 6px; border-radius: 4px; background: rgba(22, 163, 74, 0.12); color: #16a34a; font-weight: 600;">AppID 草稿直连</span>
                                <span class="metrix-platform-status" id="status-wechat">${wechatStatusInit}</span>
                            </label>
                            <label class="metrix-platform-item" data-platform="wechat_newspic" title="纯前端提取图文或自动生成 3:4 极客卡片，直推公众号小绿书草稿箱">
                                <input type="checkbox" value="wechat_newspic" style="accent-color: #16a34a;" />
                                <span style="font-weight: 600;">🟢 微信小绿书</span>
                                <span class="metrix-platform-status" id="status-wechat_newspic">${newspicStatusInit}</span>
                            </label>
                            <label class="metrix-platform-item" data-platform="xiaohongshu" title="零风控接力悬浮台 / 拟人慢速话题变蓝双模">
                                <input type="checkbox" value="xiaohongshu" style="accent-color: #ff2442;" />
                                <span style="font-weight: 600;">📕 小红书图文</span>
                                <span class="metrix-platform-status" id="status-xiaohongshu">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkZhihuDefault ? 'active' : ''}" data-platform="zhihu">
                                <input type="checkbox" ${checkZhihuDefault ? 'checked' : ''} value="zhihu" style="accent-color: #0284c7;" />
                                <span>知乎专栏</span>
                                <span class="metrix-platform-status" id="status-zhihu">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="juejin">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="juejin" style="accent-color: #0284c7;" />
                                <span>稀土掘金</span>
                                <span class="metrix-platform-status" id="status-juejin">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="csdn">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="csdn" style="accent-color: #0284c7;" />
                                <span>CSDN 博客</span>
                                <span class="metrix-platform-status" id="status-csdn">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="toutiao">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="toutiao" style="accent-color: #0284c7;" />
                                <span>今日头条</span>
                                <span class="metrix-platform-status" id="status-toutiao">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="bilibili">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="bilibili" style="accent-color: #0284c7;" />
                                <span>B站专栏</span>
                                <span class="metrix-platform-status" id="status-bilibili">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="feishu">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="feishu" style="accent-color: #00d6b9;" />
                                <span>飞书云文档</span>
                                <span class="metrix-platform-status" id="status-feishu">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="x" title="停在 X 编辑框待手动点击 Post，绝不自动发送">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="x" style="accent-color: #0f172a;" />
                                <span>𝕏 X (Twitter)</span>
                                <span class="metrix-platform-status" id="status-x">⚪ 待发布</span>
                            </label>
                            <label class="metrix-platform-item ${checkOtherDefault ? 'active' : ''}" data-platform="threads" title="唤起 Threads 发帖框写入正文与配图，停在待确认态">
                                <input type="checkbox" ${checkOtherDefault ? 'checked' : ''} value="threads" style="accent-color: #111827;" />
                                <span>🌀 Threads</span>
                                <span class="metrix-platform-status" id="status-threads">⚪ 待发布</span>
                            </label>
                        </div>

                        <div id="metrix-xhs-mode-bar" class="metrix-xhs-mode-bar" style="display:none;">
                            <div class="metrix-xhs-mode-title">
                                <span>📕 小红书图文防封号模式</span>
                                <span style="font-size:11px; color:#ff2442; font-weight:600;">绝不代点发布</span>
                            </div>
                            <div class="metrix-xhs-mode-options">
                                <label class="metrix-xhs-mode-opt ${curXhsMode !== 'human_auto' ? 'active' : ''}" data-mode="safe_assist">
                                    <input type="radio" name="metrix-xhs-mode" value="safe_assist" ${curXhsMode !== 'human_auto' ? 'checked' : ''} style="accent-color:#ff2442;" />
                                    <span>🛡️ 零风控接力模式（默认推荐 · 0自动注入不封号）</span>
                                </label>
                                <label class="metrix-xhs-mode-opt ${curXhsMode === 'human_auto' ? 'active' : ''}" data-mode="human_auto">
                                    <input type="radio" name="metrix-xhs-mode" value="human_auto" ${curXhsMode === 'human_auto' ? 'checked' : ''} style="accent-color:#ff2442;" />
                                    <span>⚡ 拟人慢速填充模式（随机停顿 + 话题自动变蓝）</span>
                                </label>
                            </div>
                        </div>

                        ${!isPro
                            ? `<div id="metrix-multi-pro-upsell" style="margin-top: auto; padding: 11px 12px; background: rgba(245, 158, 11, 0.08); border-radius: 8px; border: 1px solid rgba(245, 158, 11, 0.32); font-size: 12px; line-height: 1.55; color: var(--b3-theme-on-surface); display:flex; align-items:center; justify-content:space-between; gap:10px; transition: all 0.2s;">
                                <div id="metrix-multi-pro-upsell-text">💡 <strong>单平台免费体验中</strong>：支持全平台逐个分发；升级 <strong>Pro 终身版 (¥49)</strong> 解锁 <strong>11 大渠道（含小绿书/小红书/X/Threads）一键齐发</strong>。</div>
                                <button id="metrix-inline-upsell-btn" class="metrix-top-btn metrix-top-btn-pro" style="white-space:nowrap; flex-shrink:0; padding:6px 11px;">💎 查看 Pro</button>
                               </div>`
                            : `<div style="margin-top: auto; padding: 10px 12px; background: rgba(56, 189, 248, 0.08); border-radius: 8px; border: 1px solid rgba(56, 189, 248, 0.2); font-size: 11.5px; line-height: 1.55; color: var(--b3-theme-on-surface);">
                                💡 <strong>11 大海内外双引擎</strong>：<strong>公众号 / 小绿书</strong>纯 JS 直推官方草稿箱；<strong>小红书图文</strong>及海内外社区调起「🧩 伴侣扩展」安全写入。
                               </div>`
                        }
                    </div>
                </div>

                <div class="metrix-footer">
                    <button class="metrix-btn-secondary" id="metrix-btn-copy-html">📋 仅复制微信排版</button>
                    <button class="metrix-btn-primary" id="metrix-btn-dispatch"><span>🚀 一键分发至草稿箱</span></button>
                </div>
            </div>
        `;

        new siyuan.Dialog({
            title: "",
            content: dialogContent,
            width: "840px",
            height: "680px"
        });

        const updateCoverLive = () => {
            latestCoverPromise = (async () => {
                const curTitle = document.getElementById("metrix-input-title")?.value?.trim() || docData.title;
                const curCapsule = this.isPro()
                    ? (document.getElementById("metrix-input-capsule")?.value?.trim() || defaultCapsule)
                    : FREE_DEFAULT_CAPSULE;
                const canvas = await CoverRenderer.renderWechatCover(curTitle, curCapsule);
                const img = document.getElementById("metrix-img-cover");
                if (img) img.src = CoverRenderer.canvasToDataURL(canvas);
                coverBuffer = await CoverRenderer.canvasToBuffer(canvas);
                return coverBuffer;
            })();
            return latestCoverPromise;
        };

        setTimeout(() => {
            const tInput = document.getElementById("metrix-input-title");
            if (tInput) {
                tInput.value = docData.title || "";
                tInput.oninput = () => updateCoverLive();
            }
            const cInput = document.getElementById("metrix-input-capsule");
            if (cInput) {
                if (isPro) {
                    cInput.oninput = () => updateCoverLive();
                } else {
                    cInput.onclick = () => this.openLicenseDialog();
                }
            }
            const proHint = document.getElementById("metrix-capsule-pro-hint");
            if (proHint) {
                proHint.onclick = () => this.openLicenseDialog();
            }
            const dInput = document.getElementById("metrix-input-digest");
            if (dInput) {
                dInput.value = docData.digest || "";
            }

            const wxQuickCfg = document.getElementById("metrix-wx-quick-cfg");
            if (wxQuickCfg) {
                wxQuickCfg.onclick = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.openSettingsDialog();
                };
            }
            const wxNewspicQuickCfg = document.getElementById("metrix-wx-newspic-quick-cfg");
            if (wxNewspicQuickCfg) {
                wxNewspicQuickCfg.onclick = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this.openSettingsDialog();
                };
            }

            const labelUpsell = document.getElementById("metrix-label-upsell");
            if (labelUpsell) {
                labelUpsell.onclick = () => this.openLicenseDialog();
            }
            const inlineUpsellBtn = document.getElementById("metrix-inline-upsell-btn");
            if (inlineUpsellBtn) {
                inlineUpsellBtn.onclick = () => this.openLicenseDialog();
            }

            const syncXhsModeBar = () => {
                const xhsCb = document.querySelector(".metrix-platforms-grid input[value='xiaohongshu']");
                const xhsBar = document.getElementById("metrix-xhs-mode-bar");
                if (xhsBar) {
                    xhsBar.style.display = xhsCb && xhsCb.checked ? "flex" : "none";
                }
            };
            syncXhsModeBar();

            document.querySelectorAll("input[name='metrix-xhs-mode']").forEach(radio => {
                radio.onchange = () => {
                    const mode = radio.value === "human_auto" ? "human_auto" : "safe_assist";
                    document.querySelectorAll(".metrix-xhs-mode-opt").forEach(el => {
                        el.classList.toggle("active", el.getAttribute("data-mode") === mode);
                    });
                    this.saveConfig({ xhsMode: mode });
                };
            });

            const applyPresetSelection = (targetSet) => {
                document.querySelectorAll(".metrix-platforms-grid .metrix-platform-item").forEach(labelEl => {
                    const cb = labelEl.querySelector("input[type='checkbox']");
                    if (!cb) return;
                    const checked = targetSet.has(cb.value);
                    cb.checked = checked;
                    labelEl.classList.toggle("active", checked);
                });
                syncXhsModeBar();
            };

            const presetLong = document.getElementById("metrix-preset-long");
            if (presetLong) {
                presetLong.onclick = () => applyPresetSelection(new Set(["wechat", "zhihu", "juejin", "csdn", "toutiao", "bilibili", "feishu", "x", "threads"]));
            }
            const presetPic = document.getElementById("metrix-preset-pic");
            if (presetPic) {
                presetPic.onclick = () => applyPresetSelection(new Set(["wechat_newspic", "xiaohongshu"]));
            }
            const presetAll = document.getElementById("metrix-preset-all");
            if (presetAll) {
                presetAll.onclick = () => applyPresetSelection(new Set(["wechat", "wechat_newspic", "xiaohongshu", "zhihu", "juejin", "csdn", "toutiao", "bilibili", "feishu", "x", "threads"]));
            }

            document.querySelectorAll(".metrix-platforms-grid .metrix-platform-item").forEach(labelEl => {
                const cb = labelEl.querySelector("input[type='checkbox']");
                if (cb) {
                    cb.onchange = () => {
                        if (!this.isPro() && cb.checked) {
                            let switchedFromOther = false;
                            document.querySelectorAll(".metrix-platforms-grid .metrix-platform-item").forEach(otherLabel => {
                                if (otherLabel === labelEl) return;
                                const otherCb = otherLabel.querySelector("input[type='checkbox']");
                                if (otherCb && otherCb.checked) {
                                    otherCb.checked = false;
                                    otherLabel.classList.remove("active");
                                    switchedFromOther = true;
                                }
                            });
                            if (switchedFromOther) {
                                const platformName = labelEl.querySelector("span:not(.metrix-platform-status)")?.textContent?.trim() || cb.value;
                                siyuan.showMessage(`💡 已切换为「${platformName}」｜多平台一键并发齐发为 Pro 终身版专属权益`, 2600, "info");
                                const upsellBox = document.getElementById("metrix-multi-pro-upsell");
                                const upsellText = document.getElementById("metrix-multi-pro-upsell-text");
                                const upsellBtn = document.getElementById("metrix-inline-upsell-btn");
                                if (upsellBox && upsellText) {
                                    upsellBox.style.background = "rgba(245, 158, 11, 0.16)";
                                    upsellBox.style.borderColor = "#f59e0b";
                                    upsellText.innerHTML = `⚡ <strong>已切换为「${this.escapeHtml(platformName)}」</strong>：同时勾选多平台并发齐发需解锁 <strong>Pro 终身版 (¥49)</strong>，1 秒同时写入 11 大渠道草稿箱。`;
                                    if (upsellBtn) upsellBtn.textContent = "💎 立即解锁齐发";
                                }
                            }
                        }
                        labelEl.classList.toggle("active", cb.checked);
                        syncXhsModeBar();
                    };
                }
            });

            const actBtn = document.getElementById("metrix-header-activate");
            if (actBtn) {
                actBtn.onclick = () => this.openLicenseDialog();
            }

            const compBtn = document.getElementById("metrix-header-companion");
            if (compBtn) {
                compBtn.onclick = () => this.openCompanionGuideDialog();
            }

            const setBtn = document.getElementById("metrix-header-settings");
            if (setBtn) {
                setBtn.onclick = () => this.openSettingsDialog();
            }
        }, 30);

        const copyBtn = document.getElementById("metrix-btn-copy-html");
        if (copyBtn) {
            copyBtn.onclick = () => {
                const blob = new Blob([inlineHtml], { type: "text/html" });
                const textBlob = new Blob([docData.markdown], { type: "text/plain" });
                navigator.clipboard.write([
                    new ClipboardItem({ "text/html": blob, "text/plain": textBlob })
                ]).then(() => {
                    siyuan.showMessage("✔ 微信极客内联排版已复制到剪贴板！", 3000, "info");
                });
            };
        }

        const dispatchBtn = document.getElementById("metrix-btn-dispatch");
        if (dispatchBtn) {
            dispatchBtn.onclick = async () => {
                const freshCoverBuf = await latestCoverPromise;
                await this.executeDispatch(docData, inlineHtml, freshCoverBuf);
            };
        }
    }

    async executeDispatch(docData, inlineHtml, coverBuffer) {
        const titleInput = document.getElementById("metrix-input-title");
        const digestInput = document.getElementById("metrix-input-digest");
        const finalTitle = (titleInput ? titleInput.value.trim() : "") || docData.title;
        const finalDigest = (digestInput ? digestInput.value.trim() : "") || docData.digest;

        if (!finalTitle) {
            siyuan.showMessage("文章标题不能为空，请先在标题栏填写标题", 3000, "error");
            return;
        }

        const checkedPlatforms = [];
        document.querySelectorAll(".metrix-platforms-grid input[type='checkbox']:checked").forEach(cb => {
            checkedPlatforms.push(cb.value);
        });

        if (checkedPlatforms.length === 0) {
            siyuan.showMessage("请至少勾选一个目标平台", 3000, "error");
            return;
        }

        const isPro = this.isPro();

        // 1. 免费版每日使用次数拦截（每日限 3 次）
        if (!isPro && this.getRemainingFreeRuns() <= 0) {
            const upgradeNow = confirm(`💡【Metrix 今日免费额度已用完】\n\n免费社区版每日支持发布 ${FREE_DAILY_LIMIT} 次（明日 00:00 自动恢复）。\n\n点击【确定】立即升级终身专业版（¥49 一次买断，永久解锁不限次数 + 海内外 11 大渠道一键齐发）！`);
            if (upgradeNow) {
                this.openLicenseDialog();
            }
            return;
        }

        // 2. 免费版单次发布平台数拦截（每次限 1 个平台）
        let targetPlatforms = checkedPlatforms;
        if (!isPro && targetPlatforms.length > FREE_MAX_PLATFORMS) {
            const shouldUpgrade = confirm(`💡【Metrix 免费版限制提示】\n\n免费版每次仅支持发布 ${FREE_MAX_PLATFORMS} 个平台（当前已选 ${targetPlatforms.length} 个，每日限 ${FREE_DAILY_LIMIT} 次）。\n\n点击【确定】立即升级/激活终身专业版（¥49 一次买断，解锁海内外 11 大渠道并发齐发），点击【取消】仅发布首个选中平台。`);
            if (shouldUpgrade) {
                this.openLicenseDialog();
                return;
            } else {
                targetPlatforms = targetPlatforms.slice(0, FREE_MAX_PLATFORMS);
            }
        }

        // 3. 校验微信公众号 AppID & AppSecret 配置（公众号长图文 & 微信小绿书共用凭证）
        const wantsWechat = targetPlatforms.includes("wechat");
        const wantsNewspic = targetPlatforms.includes("wechat_newspic");
        const wantsXhs = targetPlatforms.includes("xiaohongshu");
        const wxAppId = (this.config.wechatMp?.appId || "").trim();
        const wxAppSecret = (this.config.wechatMp?.appSecret || "").trim();
        const hasWxCreds = Boolean(wxAppId && wxAppSecret);
        const canDispatchWechat = wantsWechat && hasWxCreds;
        const canDispatchNewspic = wantsNewspic && hasWxCreds;

        if ((wantsWechat || wantsNewspic) && !hasWxCreds) {
            if (wantsWechat) {
                const wxStatusEl = document.getElementById("status-wechat");
                if (wxStatusEl) wxStatusEl.innerHTML = `<span style="color:#d97706;">⚙️ 未配密钥</span>`;
            }
            if (wantsNewspic) {
                const npStatusEl = document.getElementById("status-wechat_newspic");
                if (npStatusEl) npStatusEl.innerHTML = `<span style="color:#d97706;">⚙️ 未配密钥</span>`;
            }
            siyuan.showMessage("⚙️ 请先在「偏好设置」中填写微信公众号 AppID 与 AppSecret", 3500, "error");
            this.openSettingsDialog();
        }

        const companionPlatforms = targetPlatforms.filter(p => p !== "wechat" && p !== "wechat_newspic");
        if (!canDispatchWechat && !canDispatchNewspic && companionPlatforms.length === 0) {
            return;
        }

        // 4. 若勾选了微信小绿书或小红书图文，提前提取顺序图片（无图时纯前端 Canvas 自动生成 1080×1440 3:4 极客卡片组）
        let editorialImages = [];
        if (canDispatchNewspic || wantsXhs) {
            const maxNeeded = canDispatchNewspic ? 20 : 9;
            const rawOrdered = (docData.orderedImages && docData.orderedImages.length > 0)
                ? docData.orderedImages
                : DocParser.extractOrderedImages(docData.markdown, docData.docId, maxNeeded);

            for (const imgItem of rawOrdered.slice(0, maxNeeded)) {
                try {
                    const resolved = await ThemeEngine.resolveImagePayload(imgItem, docData.dataDir);
                    if (resolved && resolved.buffer && resolved.buffer.length > 0) {
                        editorialImages.push(resolved);
                    }
                } catch (e) {
                    console.warn("[Metrix] 图文图片读取跳过:", imgItem?.src, e);
                }
            }

            if (editorialImages.length === 0) {
                const curCapsule = isPro
                    ? (document.getElementById("metrix-input-capsule")?.value?.trim() || this.config.capsule || FREE_DEFAULT_CAPSULE)
                    : FREE_DEFAULT_CAPSULE;
                const curAuthor = isPro ? (this.config.author || DEFAULT_CONFIG.author) : DEFAULT_CONFIG.author;
                siyuan.showMessage("🎨 当前笔记无配图，正在自动生成 3:4 高清图文卡片...", 2000, "info");
                editorialImages = await CoverRenderer.renderNewspicCards({
                    title: finalTitle,
                    markdown: docData.markdown,
                    author: curAuthor,
                    capsule: curCapsule,
                    theme: "light",
                    maxCards: 4
                });
            }
        }

        let shouldConsumeFreeQuota = false;

        // 5. 分支 A：调起浏览器伴侣分发其余社区平台（含小红书图文）
        if (companionPlatforms.length > 0) {
            let finalMarkdown = docData.markdown;
            const bedType = isPro ? (this.config.imageBed?.type || "none") : "none";
            if (bedType !== "none" && docData.referencedAssets?.length > 0) {
                try {
                    finalMarkdown = await this.uploadAssetsViaImageBed(docData.markdown, docData.referencedAssets, docData.dataDir, bedType);
                } catch (e) {
                    console.warn("[Metrix] 图床处理失败，自动保留原稿:", e);
                }
            }
            const companionHtml = await ThemeEngine.renderToSemanticHtml(finalMarkdown, docData.dataDir);

            const taskId = `task_${Date.now()}`;
            const taskToken = Math.random().toString(36).substring(2, 12);

            const assetsMap = new Map();
            assetsMap.set("cover", { filePath: null, buffer: coverBuffer, mimeType: "image/png" });
            const coverBase64 = coverBuffer ? coverBuffer.toString("base64") : "";
            const assetsList = [];

            if (docData.referencedAssets.length > 0) {
                for (let i = 0; i < docData.referencedAssets.length; i++) {
                    const item = docData.referencedAssets[i];
                    const assetId = `asset_${i + 1}`;
                    let rawDataUrl = await ThemeEngine.resolveAssetBase64(item.relPath, docData.dataDir);
                    let detectedMime = "image/png";
                    let base64 = rawDataUrl;
                    if (rawDataUrl && rawDataUrl.includes(",")) {
                        const mimeMatch = rawDataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/);
                        if (mimeMatch) detectedMime = mimeMatch[1];
                        base64 = rawDataUrl.split(",")[1];
                    }
                    if (fs && docData.dataDir) {
                        const diskPath = path.join(docData.dataDir, item.relPath);
                        if (fs.existsSync(diskPath)) {
                            assetsMap.set(assetId, { filePath: diskPath, buffer: null, mimeType: detectedMime });
                        }
                    }
                    assetsList.push({
                        id: assetId,
                        relPath: item.relPath,
                        uploadedUrl: item.uploadedUrl || "",
                        filename: item.filename || `${assetId}.png`,
                        alt: item.alt || "",
                        base64: base64 || null,
                        mimeType: detectedMime
                    });
                }
            }

            const tagList = (this.config.tags || "技术, 生产力, 架构").split(/[,，\s]+/).filter(Boolean);

            let xhsPayload = null;
            if (wantsXhs) {
                const xhsParsed = DocParser.parseXiaohongshuContent(docData.markdown, finalTitle, this.config.tags);
                const selectedMode = document.querySelector("input[name='metrix-xhs-mode']:checked")?.value
                    || this.config.xhsMode
                    || "safe_assist";
                const xhsMode = selectedMode === "human_auto" ? "human_auto" : "safe_assist";
                if (xhsMode !== this.config.xhsMode) {
                    await this.saveConfig({ xhsMode });
                }
                xhsPayload = {
                    mode: xhsMode,
                    title: xhsParsed.title,
                    bodyWithoutTags: xhsParsed.bodyWithoutTags,
                    hashtags: xhsParsed.hashtags,
                    imagesDataUrls: editorialImages.slice(0, 9).map(img => img.dataUrl).filter(Boolean)
                };
            }

            const taskData = {
                id: taskId,
                article: {
                    title: finalTitle,
                    markdown: finalMarkdown,
                    html: companionHtml,
                    digest: finalDigest,
                    tags: tagList,
                    coverAssetId: "cover",
                    coverBase64,
                    assets: assetsList,
                    xhs: xhsPayload
                },
                platforms: companionPlatforms,
                createdAt: Date.now()
            };

            this.bridgeServer.registerTask(taskId, taskData, taskToken, assetsMap);

            companionPlatforms.forEach(p => {
                const el = document.getElementById(`status-${p}`);
                if (el) el.innerHTML = "⏳ 分发中...";
            });

            const handshakeUrl = `http://127.0.0.1:${this.bridgeServer.port}/matrix-bridge?taskId=${taskId}#token=${taskToken}`;
            window.open(handshakeUrl);
            shouldConsumeFreeQuota = true;
            if (!canDispatchWechat && !canDispatchNewspic) {
                siyuan.showMessage("🚀 已唤起浏览器伴侣，草稿正在自动写入...", 4000, "info");
            }
        }

        // 6. 分支 B：微信公众号长图文 & 微信小绿书官方草稿箱直推
        if (canDispatchWechat || canDispatchNewspic) {
            const dispatchBtn = document.getElementById("metrix-btn-dispatch");
            if (dispatchBtn) dispatchBtn.disabled = true;
            try {
                if (canDispatchWechat) {
                    const wxStatusEl = document.getElementById("status-wechat");
                    try {
                        await WeChatOfficialApi.publishDraft({
                            appId: wxAppId,
                            appSecret: wxAppSecret,
                            title: finalTitle,
                            author: isPro ? (this.config.author || "") : "",
                            digest: finalDigest,
                            contentHtml: inlineHtml,
                            coverBuffer,
                            onStep: (stepText) => {
                                if (wxStatusEl) wxStatusEl.innerHTML = `<span style="color:#0284c7;">${stepText}</span>`;
                            }
                        });
                        if (wxStatusEl) {
                            wxStatusEl.innerHTML = `<a href="https://mp.weixin.qq.com" target="_blank" style="color:#22c55e; font-weight:600;">✔ 已入草稿箱</a>`;
                        }
                        shouldConsumeFreeQuota = true;
                    } catch (err) {
                        const errMsg = err?.message || String(err);
                        if (wxStatusEl) {
                            wxStatusEl.innerHTML = `<span style="color:#ef4444; cursor:help;" title="${this.escapeHtml(errMsg)}">❌ 推送失败</span>`;
                        }
                        siyuan.showMessage("❌ 公众号推送失败：" + errMsg, 5500, "error");
                    }
                }

                if (canDispatchNewspic) {
                    const npStatusEl = document.getElementById("status-wechat_newspic");
                    try {
                        const newspicContent = WeChatOfficialApi.formatNewspicContent(docData.markdown, finalTitle);
                        const npRes = await WeChatOfficialApi.publishNewspicDraft({
                            appId: wxAppId,
                            appSecret: wxAppSecret,
                            title: finalTitle,
                            author: isPro ? (this.config.author || "") : "",
                            contentText: newspicContent,
                            images: editorialImages.slice(0, 20),
                            onStep: (stepText) => {
                                if (npStatusEl) npStatusEl.innerHTML = `<span style="color:#0284c7;">${stepText}</span>`;
                            }
                        });
                        if (npStatusEl) {
                            npStatusEl.innerHTML = `<a href="https://mp.weixin.qq.com" target="_blank" style="color:#22c55e; font-weight:600;">✔ 已入草稿(${npRes.imageCount}图)</a>`;
                        }
                        shouldConsumeFreeQuota = true;
                        siyuan.showMessage(`🎉 微信小绿书已直推草稿箱（${npRes.imageCount} 张图）！`, 4500, "info");
                    } catch (err) {
                        const errMsg = err?.message || String(err);
                        if (npStatusEl) {
                            npStatusEl.innerHTML = `<span style="color:#ef4444; cursor:help;" title="${this.escapeHtml(errMsg)}">❌ 推送失败</span>`;
                        }
                        siyuan.showMessage("❌ 微信小绿书推送失败：" + errMsg, 5500, "error");
                    }
                } else if (canDispatchWechat) {
                    if (companionPlatforms.length > 0) {
                        siyuan.showMessage("🎉 微信公众号已直推草稿箱，其余社区正在后台同步！", 4500, "info");
                    } else {
                        siyuan.showMessage("🎉 微信公众号草稿推送成功！可前往公众平台后台预览群发", 4500, "info");
                    }
                }
            } finally {
                if (dispatchBtn) dispatchBtn.disabled = false;
            }
        }

        // 6. 扣减免费版今日额度并实时刷新顶部徽标（配置报错不误扣额度）
        if (!isPro && shouldConsumeFreeQuota) {
            await this.consumeFreeRun();
            const badgeEl = document.getElementById("metrix-free-quota-badge");
            if (badgeEl) {
                badgeEl.innerText = `免费版 (单次1平台 · 今日余 ${this.getRemainingFreeRuns()}/${FREE_DAILY_LIMIT}次)`;
            }
        }
    }

    async uploadAssetsViaImageBed(markdown, referencedAssets, dataDir, bedType) {
        if (!referencedAssets || referencedAssets.length === 0) return markdown;

        if (bedType === "picgo") {
            return this.uploadAssetsViaPicGo(markdown, referencedAssets, dataDir);
        } else if (bedType === "imgbb") {
            return this.uploadAssetsViaImgBB(markdown, referencedAssets, dataDir);
        } else if (bedType === "github") {
            return this.uploadAssetsViaGitHub(markdown, referencedAssets, dataDir);
        }
        return markdown;
    }

    async uploadAssetsViaPicGo(markdown, referencedAssets, dataDir) {
        if (!fs || !path) return markdown;
        const fileList = [];
        const tempFiles = [];
        const assetPathMap = new Map();

        for (let i = 0; i < referencedAssets.length; i++) {
            const item = referencedAssets[i];
            let diskPath = dataDir ? path.join(dataDir, item.relPath) : "";
            if (diskPath && fs.existsSync(diskPath)) {
                fileList.push(diskPath);
                assetPathMap.set(item.relPath, diskPath);
            } else if (os) {
                try {
                    const dataUrl = await ThemeEngine.resolveAssetBase64(item.relPath, dataDir);
                    if (dataUrl) {
                        const rawB64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
                        const safeName = (item.filename || `asset_${i + 1}.png`).replace(/[^a-zA-Z0-9._-]/g, "_");
                        const tmpPath = path.join(os.tmpdir(), `metrix_picgo_${Date.now()}_${i}_${safeName}`);
                        fs.writeFileSync(tmpPath, Buffer.from(rawB64, "base64"));
                        fileList.push(tmpPath);
                        tempFiles.push(tmpPath);
                        assetPathMap.set(item.relPath, tmpPath);
                    }
                } catch (e) {}
            }
        }
        if (fileList.length === 0) return markdown;

        try {
            siyuan.showMessage("正在通过 PicGo 上传图片至图床...", 2000, "info");
            const picgoUrl = this.config.imageBed?.picgoUrl || "http://127.0.0.1:36677/upload";
            const resp = await fetch(picgoUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ list: fileList })
            });
            const resJson = await resp.json();
            if (resJson.success && Array.isArray(resJson.result)) {
                let updatedMd = markdown;
                for (let i = 0; i < fileList.length; i++) {
                    const localDiskPath = fileList[i];
                    const uploadedUrl = resJson.result[i];
                    if (uploadedUrl) {
                        for (const [relPath, dPath] of assetPathMap.entries()) {
                            if (dPath === localDiskPath) {
                                updatedMd = updatedMd.split(relPath).join(uploadedUrl);
                                const matched = referencedAssets.find(a => a.relPath === relPath);
                                if (matched) matched.uploadedUrl = uploadedUrl;
                            }
                        }
                    }
                }
                siyuan.showMessage("✔ PicGo 图床上传完成并已替换外链！", 2500, "info");
                return updatedMd;
            }
        } catch (err) {
            console.warn("[Metrix] 调用 PicGo 接口失败:", err);
            siyuan.showMessage("⚠️ PicGo 接口连接失败，自动保留原稿排版", 3000, "info");
        } finally {
            for (const tmp of tempFiles) {
                try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
            }
        }
        return markdown;
    }

    async uploadAssetsViaImgBB(markdown, referencedAssets, dataDir) {
        const apiKey = (this.config.imageBed?.imgbbKey || "").trim();
        if (!apiKey) {
            siyuan.showMessage("⚠️ 未配置 ImgBB API Key，自动保留原稿图片", 3000, "info");
            return markdown;
        }

        siyuan.showMessage("正在上传正文图片至 ImgBB 云图床...", 2000, "info");
        let updatedMd = markdown;
        let successCount = 0;

        for (const item of referencedAssets) {
            try {
                const dataUrl = await ThemeEngine.resolveAssetBase64(item.relPath, dataDir);
                if (!dataUrl) continue;
                const rawBase64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;

                const formBody = new URLSearchParams();
                formBody.append("image", rawBase64);
                if (item.filename) {
                    formBody.append("name", item.filename.replace(/\.[^.]+$/, ""));
                }

                const resp = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                    body: formBody.toString()
                });
                const resJson = await resp.json();
                const remoteUrl = resJson?.data?.url || resJson?.data?.display_url;
                if (remoteUrl) {
                    item.uploadedUrl = remoteUrl;
                    updatedMd = updatedMd.split(item.relPath).join(remoteUrl);
                    successCount++;
                }
            } catch (e) {
                console.warn("[Metrix] ImgBB 单图上传异常:", item.relPath, e);
            }
        }

        if (successCount > 0) {
            siyuan.showMessage(`✔ ImgBB 云图床上传完成 (${successCount} 张)！`, 2500, "info");
        }
        return updatedMd;
    }

    async uploadAssetsViaGitHub(markdown, referencedAssets, dataDir) {
        const repo = (this.config.imageBed?.githubRepo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "");
        const token = (this.config.imageBed?.githubToken || "").trim();
        if (!repo || !repo.includes("/") || !token) {
            siyuan.showMessage("⚠️ GitHub 仓库或 Token 配置不完整，自动保留原稿图片", 3000, "info");
            return markdown;
        }

        siyuan.showMessage("正在同步图片至 GitHub 图床仓库...", 2000, "info");
        let updatedMd = markdown;
        let successCount = 0;
        const datePrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");

        for (let i = 0; i < referencedAssets.length; i++) {
            const item = referencedAssets[i];
            try {
                const dataUrl = await ThemeEngine.resolveAssetBase64(item.relPath, dataDir);
                if (!dataUrl) continue;
                const rawBase64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
                const safeName = (item.filename || `img_${i + 1}.png`).replace(/[^a-zA-Z0-9._-]/g, "_");
                const remotePath = `metrix/${datePrefix}_${Date.now()}_${safeName}`;

                const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${remotePath}`, {
                    method: "PUT",
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Accept": "application/vnd.github+json",
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        message: `chore(metrix): upload ${safeName}`,
                        content: rawBase64,
                        committer: {
                            name: repo.split("/")[0] || "metrix-bot",
                            email: "noreply@users.noreply.github.com"
                        }
                    })
                });

                if (resp.ok) {
                    const cdnUrl = `https://gcore.jsdelivr.net/gh/${repo}@main/${remotePath}`;
                    item.uploadedUrl = cdnUrl;
                    updatedMd = updatedMd.split(item.relPath).join(cdnUrl);
                    successCount++;
                }
            } catch (e) {
                console.warn("[Metrix] GitHub 图床单图上传异常:", item.relPath, e);
            }
        }

        if (successCount > 0) {
            siyuan.showMessage(`✔ GitHub + CDN 图床上传完成 (${successCount} 张)！`, 2500, "info");
        }
        return updatedMd;
    }

    handleTaskStatusUpdate(data) {
        const { platform, status, draftUrl, error } = data;
        const el = document.getElementById(`status-${platform}`);
        if (!el) return;

        if (status === "success" || status === "drafted") {
            el.innerHTML = draftUrl ? `<a href="${draftUrl}" target="_blank" style="color: #22c55e;">✔ 已就绪</a>` : `<span style="color: #22c55e;">✔ 已就绪</span>`;
        } else if (status === "failed") {
            el.innerHTML = `<span style="color: #ef4444;" title="${error || '未知错误'}">❌ 失败</span>`;
        } else {
            el.innerHTML = `<span>⏳ ${status}</span>`;
        }
    }

    escapeHtml(str) {
        if (!str) return "";
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
}

module.exports = MetrixPlugin;
