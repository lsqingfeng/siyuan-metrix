# Metrix: 自媒体多平台矩阵分发商业套件架构设计

本项目位于 `/Users/liushuai/Documents/develop/workspace/myProject/metrix/`，是一个**完全独立、零外部依赖、面向商用上架**的新一代自媒体分发系统。与现有的生产发布体系彻底物理隔离。

---

## 核心设计原则

1. **零 Python 依赖（Zero External Dependency）**：
   * 原生运行于思源笔记的 Electron / Node.js 运行时中；
   * 彻底抛弃本地独立启动的 `server.py` 进程，安装思源插件即可开箱即用。
2. **洁净室重构与去特征化（Clean-Room Refactoring & De-Risking）**：
   * 彻底摒弃历史特征字眼（全面脱钩 WeSight / 旧项目残留）；
   * 采用全新私有握手协议：`Matrix-Bridge v2.0`；
   * 平台注入代码全部原生重新编写，并接入混淆与加固打包流水线。
3. **完全物理隔离（Zero Impact on Existing Production）**：
   * 不修改现有的 `siyuan-matrix-publisher`、`wechat-agent`、`matrix-chrome-extension` 及每日自动化任务；
   * 端口、目录、配置、扩展 ID 完全独立。

---

## 系统拓扑架构

```mermaid
flowchart LR
    subgraph Siyuan["思源笔记端 (metrix/siyuan-plugin)"]
        ActiveDoc["当前文档解析 (Markdown + 本地资源)"]
        CanvasEngine["Canvas 封面动态渲染器 (16:9 / 2.35:1)"]
        ThemeEngine["极客蓝富文本内联排版引擎"]
        HttpBridge["纯 JS 本地 HTTP Bridge 桥接服务<br/>(Node.js 监听 127.0.0.1:18999)"]
        PluginDialog["现代化分发控制面板 (⌥M)"]
    end

    subgraph Browser["日常浏览器端 (metrix/browser-companion)"]
        BridgeListener["Bridge 握手内容脚本 (匹配 /matrix-bridge)"]
        ServiceWorker["后台调度核心 (Manifest V3 Service Worker)"]
        Adapters["平台原生适配器 (知乎 / 掘金 / CSDN / 头条 / B站)"]
        UserSessions["日常已登录的官方 Cookies"]
    end

    ActiveDoc --> CanvasEngine & ThemeEngine --> HttpBridge
    PluginDialog -->|1. 创建任务| HttpBridge
    PluginDialog -->|2. 调起浏览器| BridgeListener
    BridgeListener -->|3. Handoff 握手| ServiceWorker
    ServiceWorker -->|4. 获取任务物料| HttpBridge
    UserSessions -. 自动携带鉴权 .-> Adapters
    ServiceWorker -->|5. 调度注入| Adapters
    Adapters -->|6. 保存草稿| 平台官方草稿箱
    Adapters -. 7. 实时状态回传 .-> ServiceWorker -.-> HttpBridge --> PluginDialog
```

---

## 私有通信协议设计 (Matrix-Bridge Protocol v2.0)

1. **握手入口**：
   * `GET http://127.0.0.1:18999/matrix-bridge?taskId={TASK_ID}#token={TASK_TOKEN}`
2. **任务清单接口**：
   * `GET http://127.0.0.1:18999/api/v2/tasks/{taskId}/manifest`
   * 鉴权：`X-Matrix-Token: {TASK_TOKEN}`
   * 返回格式：
     ```json
     {
       "id": "task_20261108_xxx",
       "article": {
         "title": "文章标题",
         "markdown": "...",
         "html": "...",
         "digest": "摘要",
         "tags": ["技术", "架构"]
       },
       "assets": [
         { "id": "cover", "filename": "cover.png", "mimeType": "image/png" },
         { "id": "img_01", "filename": "1.png", "mimeType": "image/png" }
       ],
       "platforms": ["zhihu", "juejin", "csdn", "toutiao", "bilibili"]
     }
     ```
3. **静态资源下载接口**：
   * `GET http://127.0.0.1:18999/api/v2/tasks/{taskId}/assets/{assetId}`
4. **状态与进度回传接口**：
   * `POST http://127.0.0.1:18999/api/v2/tasks/{taskId}/status`
   * Body：
     ```json
     {
       "platform": "zhihu",
       "status": "success",
       "draftUrl": "https://zhuanlan.zhihu.com/p/xxx/edit",
       "error": null
     }
     ```

---

## 目录规划

```text
myProject/metrix/
├── docs/
│   └── ARCHITECTURE.md          # 本技术架构设计书
├── siyuan-plugin/               # 思源商业版插件工程
│   ├── plugin.json              # 插件清单
│   ├── index.js                 # 插件入口
│   ├── index.css                # 插件界面样式
│   └── modules/
│       ├── bridge-server.js     # 纯 Node.js HTTP 桥接服务
│       ├── doc-parser.js        # 文档内容与资源解析器
│       ├── theme-engine.js      # 极客蓝内联样式排版引擎
│       └── cover-renderer.js    # Canvas 封面渲染引擎
└── browser-companion/           # 浏览器端伴侣扩展工程
    ├── manifest.json            # 纯净 Manifest V3 清单
    ├── src/
    │   ├── background/          # Service Worker
    │   ├── bridge/              # 握手监听器
    │   ├── platforms/           # 各平台独立适配器 (知乎/掘金/CSDN...)
    │   └── utils/               # 工具库与事件拟真
    └── scripts/
        └── build.js             # 混淆、加固与打包流水线
```
