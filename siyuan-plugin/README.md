# 🚀 Metrix: Multi-Platform Matrix Publisher for SiYuan Note

> **Eliminate fragile Python/Selenium scrapers and tedious manual copy-pasting.**  
> Metrix is a commercial-grade publishing suite designed for technical writers, indie developers, and architects. With zero Python dependencies and native browser session reuse, dispatch articles directly from SiYuan Note into Zhihu, Juejin, CSDN, Toutiao, and Bilibili draftboxes in one click.

---

## 🌟 Why Metrix?

Traditional Python/Playwright automation scripts present severe obstacles:
1. **Environment Complexity**: Requires installing Python, pip packages, virtualenvs, and headless browser binaries.
2. **Account Ban Risks**: Synthetic headless browser fingerprints trigger bot detection, CAPTCHAs, and account freezes.
3. **Maintenance Overhead**: Frequent DOM changes and driver incompatibilities break scripts.

**The Metrix Architecture:**
- ⚡ **Zero Python Dependency**: Pure Node.js and native JavaScript. Works straight out of the box inside SiYuan Note.
- 🛡️ **Session Reuse Security**: Uses your regular Chrome/Edge authenticated sessions. Zero credential sharing and zero risk of bot bans.
- 🎨 **Dynamic Canvas Cover**: Generates a standard 2.35:1 high-resolution geek-blue banner from your title and branding in real time.
- 💻 **Geek Terminal Styling**: Formats terminal code blocks with Mac 🔴🟡🟢 window decorations, ready for one-click WeChat Official Account copy.
- 🖼️ **Flexible Image Pipeline**: Supports pure geek text/code flow (shielded against platform anti-hotlinking), local PicGo integration, ImgBB, and GitHub + jsDelivr CDN image beds.

---

## 📱 Supported Platforms

- **Zhihu Column (知乎专栏)**: Automatic title, content, and cover injection with rich formatting.
- **Xitu Juejin (稀土掘金)**: Clean native CodeMirror injection with Markdown code syntax highlighting.
- **CSDN Blog (CSDN 博客)**: Intelligent multiline paste injection preserving headings and paragraphs.
- **Toutiao / Micro-Toutiao (今日头条)**: ByteDance creator platform rich text formatting.
- **Bilibili Articles (B站专栏)**: Preserved inline styling and typography.
- **WeChat Official Account (微信公众号)**: 1-click clipboard copy formatted with clean inline geek styles.

---

## 🛠️ Quick Start (30 Seconds)

### 1. Install SiYuan Plugin
1. Install **Metrix** from the SiYuan Marketplace (or place `siyuan-metrix` into `data/plugins/`).
2. Enable **Metrix** in SiYuan Settings -> Plugins.

### 2. Install Built-in Browser Companion
1. Press **`⌥M`** in SiYuan Note (or click the top-bar Rocket icon) to open Metrix, then click **🧩 Companion Extension** in the top right.
2. Click **Export Browser Companion (.zip)** to save `metrix-companion.zip` to your `Downloads` folder and unzip it.
3. Open `chrome://extensions/` in Chrome or Edge, enable **Developer mode**, click **Load unpacked**, and select the unzipped folder.

---

## 💎 Free vs. Lifetime Pro Edition

| Feature | Metrix Free | 💎 Metrix Lifetime Pro |
| :--- | :---: | :---: |
| Zhihu, Juejin, CSDN, Toutiao, Bilibili | ✔ | ✔ |
| WeChat Geek Inline Formatter | ✔ | ✔ |
| Real-time Canvas 2.35:1 Cover Generator | ✔ | ✔ |
| **Simultaneous Platform Dispatch** | **Up to 2 Platforms** | **Unlimited (All 6+ Platforms Parallel)** |
| **Author & Cover Capsule Branding** | Preset | **Fully Customizable** |
| **PicGo / ImgBB / GitHub CDN Image Beds** | Pure Flow | **Automated Upload & Link Replacement** |
| **Offline Ed25519 Perpetual License** | Community | **1-Time Purchase, Lifetime Updates** |

- 🛒 **Upgrade to Lifetime Pro (¥49 / $7.99)**: [https://afdian.com/a/lsqingfeng](https://afdian.com/a/lsqingfeng)

---

## 📄 License
Distributed under the MIT License. Pro features unlock offline via Ed25519 digital signature keys.
