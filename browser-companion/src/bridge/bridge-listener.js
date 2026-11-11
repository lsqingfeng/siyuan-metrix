/**
 * Metrix Bridge Listener: 监听本地握手信号并移交给后台 Service Worker
 */
(async function () {
    if (location.pathname !== "/matrix-bridge") return;

    const statusEl = document.getElementById("matrix-bridge-status");
    const setStatus = (msg, isError = false) => {
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.style.color = isError ? "#ef4444" : "#38bdf8";
        }
    };

    try {
        const searchParams = new URLSearchParams(location.search);
        const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
        const taskId = searchParams.get("taskId");
        const token = hashParams.get("token") || searchParams.get("token");

        if (!taskId || !token) {
            setStatus("握手参数不完整，请返回思源笔记重试。", true);
            return;
        }

        setStatus("正在唤醒 Metrix 伴侣扩展，准备各平台草稿...");

        const response = await chrome.runtime.sendMessage({
            type: "MATRIX_HANDOFF",
            handoff: {
                baseUrl: location.origin,
                taskId,
                token
            }
        });

        if (response && response.ok) {
            setStatus("✔ 扩展已成功接管！各平台草稿正在自动写入中，可关闭此页面。");
        } else {
            setStatus(response?.error || "扩展通信响应异常，请检查扩展是否正常运行。", true);
        }
    } catch (err) {
        console.error("[MetrixBridge] Error:", err);
        setStatus("未检测到 Metrix 伴侣扩展，请先在 Chrome 中启用该扩展。", true);
    }
})();
