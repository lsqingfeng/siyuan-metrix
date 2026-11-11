"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const METRIX_ROOT = path.resolve(ROOT_DIR, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");
const BUILD_OUTPUT = path.join(DIST_DIR, "unpacked");
const PLUGIN_COMPANION_DIR = path.join(METRIX_ROOT, "siyuan-plugin", "companion");

// 优先探测本地 Terser AST 压缩混淆引擎
let terser = null;
const terserCandidates = [
    "terser",
    "/Users/liushuai/Documents/develop/workspace/ontology/ai-onto/node_modules/terser"
];
for (const modPath of terserCandidates) {
    try {
        terser = require(modPath);
        break;
    } catch (e) {}
}

async function minifyJs(code, filename) {
    if (terser && typeof terser.minify === "function") {
        const result = await terser.minify(code, {
            compress: {
                passes: 2,
                dead_code: true,
                conditionals: true
            },
            mangle: {
                reserved: ["fillPlatformEditorInPage"]
            },
            format: {
                comments: false,
                ascii_only: false
            }
        });
        if (result && result.code) {
            return result.code;
        }
    }
    // 兜底安全压缩
    return code
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[\s;{}()])\/\/.*$/gm, "$1")
        .replace(/\n\s*\n/g, "\n")
        .trim();
}

async function copyAndBuild(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            await copyAndBuild(srcPath, destPath);
        } else if (entry.name.endsWith(".js")) {
            const rawCode = fs.readFileSync(srcPath, "utf-8");
            const minified = await minifyJs(rawCode, entry.name);
            fs.writeFileSync(destPath, minified, "utf-8");
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

(async () => {
    console.log(`🔨 开始构建 Metrix 浏览器伴侣扩展 (${terser ? "Terser AST 混淆压缩" : "标准压缩"})...`);

    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(BUILD_OUTPUT, { recursive: true });

    const manifestPath = path.join(ROOT_DIR, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    fs.writeFileSync(
        path.join(BUILD_OUTPUT, "manifest.json"),
        JSON.stringify(manifest, null, 2)
    );

    const iconsDir = path.join(BUILD_OUTPUT, "icons");
    fs.mkdirSync(iconsDir, { recursive: true });
    ["icon16.png", "icon48.png", "icon128.png"].forEach(icon => {
        fs.copyFileSync(
            path.join(ROOT_DIR, "icons", icon),
            path.join(iconsDir, icon)
        );
    });

    await copyAndBuild(path.join(ROOT_DIR, "src"), path.join(BUILD_OUTPUT, "src"));

    const zipPath = path.join(DIST_DIR, "metrix-companion.zip");
    execSync(`cd "${BUILD_OUTPUT}" && zip -r -q "${zipPath}" ./*`);
    console.log(`✔ 浏览器扩展 ZIP 打包完成: ${zipPath}`);

    // 同步内置一份到思源插件目录，供付费/免费用户在思源内一键导出安装
    fs.mkdirSync(PLUGIN_COMPANION_DIR, { recursive: true });
    const embeddedZip = path.join(PLUGIN_COMPANION_DIR, "metrix-companion.zip");
    fs.copyFileSync(zipPath, embeddedZip);
    console.log(`✔ 已内嵌同步至思源插件资源包: ${embeddedZip}`);
    console.log("🎉 Metrix 伴侣扩展构建完成！");
})().catch(err => {
    console.error("❌ 构建失败:", err);
    process.exit(1);
});
