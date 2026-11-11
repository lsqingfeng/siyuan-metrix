# 🚀 Metrix: Commercial Multi-Platform Publishing Suite for SiYuan Note

Metrix is a modern, zero-Python publishing suite designed for technical bloggers, developers, and architects. It seamlessly dispatches articles from SiYuan Note directly into Zhihu, Juejin, CSDN, Toutiao, Bilibili, and WeChat Official Accounts.

---

## 🏗️ Architecture

- **SiYuan Note Plugin (`siyuan-plugin/`)**:
  - `DocParser`: Extracts Markdown, titles, digests, and asset references from active protyle editors.
  - `CoverRenderer`: Real-time HTML5 Canvas rendering of 2.35:1 high-resolution geek-blue cover banners.
  - `ThemeEngine`: Generates Mac terminal styled inline HTML and code blocks.
  - `MatrixBridgeServer`: Lightweight local HTTP server (port 18999) exchanging secure tokens and payloads with the browser extension.
  - `LicenseManager`: Offline cryptographic license validation for Pro edition features.
- **Chrome / Edge Companion (`browser-companion/`)**:
  - Manifest V3 browser extension listening for dispatch tasks from SiYuan.
  - Reuses your existing authenticated browser sessions without storing any user passwords.
  - Injects drafts accurately into target platform editors via native APIs (CodeMirror, React Fiber, Draft.js, and multi-line clipboard inputs).
- **Commercial Tooling (`tools/`)**:
  - `generate_license.js`: Offline Pro license generator for automated e-commerce fulfillment (Gumroad, LemonSqueezy, Aifadian).

---

## 🌟 Key Highlights

1. **Zero Python Dependency**: 100% JavaScript and Node.js. Zero virtualenv setups, zero Playwright/Selenium driver crashes.
2. **Anti-Detection Session Security**: Directly leverages your standard daily browser tabs, eliminating bot detection and account risk.
3. **Smart Canvas Cover**: Dynamically generates branded 2.35:1 banners from the article title and column theme in milliseconds.
4. **Offline Licensing**: Built-in cryptographic verification that runs purely offline, preserving privacy and ensuring 100% uptime.

---

## 🚀 Quick Setup

1. **SiYuan Plugin**: Copy or symlink `siyuan-plugin` to `data/plugins/siyuan-metrix`.
2. **Browser Extension**: Open `chrome://extensions/`, enable Developer Mode, click **Load unpacked**, and select `metrix/browser-companion/dist/unpacked`.
3. **Dispatch**: Press `⌥M` in SiYuan Note, adjust materials, and click **Publish Matrix to Draftboxes**!
