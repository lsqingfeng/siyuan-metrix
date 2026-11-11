#!/usr/bin/env node
"use strict";

/**
 * Metrix v2.0 商用离线授权码签发与验真工具 (基于 Ed25519 非对称数字签名)
 * - 私钥仅保存在本地 .private/ed25519_private.pem (严禁提交 Git 或打包进插件)
 * - 客户端插件仅内置公钥 (PUBLIC KEY)，即使源码完全公开也无法伪造任何激活码
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = path.resolve(__dirname, "..");
const PRIVATE_DIR = path.join(ROOT_DIR, ".private");
const PRIV_KEY_PATH = path.join(PRIVATE_DIR, "ed25519_private.pem");
const PUB_KEY_PATH = path.join(PRIVATE_DIR, "ed25519_public.pem");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 剔除易混淆字符 0, O, 1, I

function ensureKeyPair() {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true, mode: 0o700 });
    if (fs.existsSync(PRIV_KEY_PATH) && fs.existsSync(PUB_KEY_PATH)) {
        return {
            privateKeyPem: fs.readFileSync(PRIV_KEY_PATH, "utf8"),
            publicKeyPem: fs.readFileSync(PUB_KEY_PATH, "utf8")
        };
    }

    console.log("🔐 首次运行：正在生成高强度 Ed25519 非对称公私钥对...");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });

    fs.writeFileSync(PRIV_KEY_PATH, privateKey, { encoding: "utf8", mode: 0o600 });
    fs.writeFileSync(PUB_KEY_PATH, publicKey, { encoding: "utf8", mode: 0o644 });
    console.log(`✔ 私钥已安全落盘 (请妥善备份，切勿泄露): ${PRIV_KEY_PATH}`);
    console.log(`✔ 公钥已生成: ${PUB_KEY_PATH}\n`);
    return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function randomSerial(len = 8) {
    const bytes = crypto.randomBytes(len);
    let out = "";
    for (let i = 0; i < len; i++) {
        out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return out;
}

function signLicenseKey(edition = "PRO", customSerial = null) {
    const { privateKeyPem } = ensureKeyPair();
    const cleanEdition = edition.toUpperCase() === "TEAM" ? "TEAM" : "PRO";
    const serial = (customSerial || randomSerial(8)).toUpperCase();
    const message = Buffer.from(`METRIX_V2|${cleanEdition}|${serial}`, "utf8");
    const sig = crypto.sign(null, message, privateKeyPem);
    const sigB64Url = sig.toString("base64url");
    return `MXP2-${cleanEdition}-${serial}-${sigB64Url}`;
}

function verifyLicenseKey(key, publicKeyPemOverride = null) {
    if (!key || typeof key !== "string") return { valid: false };
    const trimmed = key.trim();
    const match = trimmed.match(/^MXP2-(PRO|TEAM)-([A-Z2-9]{6,16})-([A-Za-z0-9_-]{86})$/);
    if (!match) return { valid: false };

    const edition = match[1];
    const serial = match[2];
    const sigB64Url = match[3];

    try {
        const pubPem = publicKeyPemOverride || ensureKeyPair().publicKeyPem;
        const message = Buffer.from(`METRIX_V2|${edition}|${serial}`, "utf8");
        const sigBuf = Buffer.from(sigB64Url, "base64url");
        if (sigBuf.length !== 64) return { valid: false };
        const ok = crypto.verify(null, message, pubPem, sigBuf);
        return ok ? { valid: true, edition, serial } : { valid: false };
    } catch (e) {
        return { valid: false };
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);

    if (args.includes("--pubkey")) {
        const { publicKeyPem } = ensureKeyPair();
        process.stdout.write(publicKeyPem);
        process.exit(0);
    }

    if (args.includes("--verify") || args.includes("-v")) {
        const idx = Math.max(args.indexOf("--verify"), args.indexOf("-v"));
        const key = args[idx + 1];
        if (!key) {
            console.error("❌ 错误：请提供待验证的授权码，例如: node tools/generate_license.js --verify <KEY>");
            process.exit(1);
        }
        const res = verifyLicenseKey(key);
        if (res.valid) {
            const label = res.edition === "TEAM" ? "工作室团队版 (5设备)" : "终身专业版 (单人买断)";
            console.log(`✔ 授权码校验通过！版本: [${label}] | 序列号: ${res.serial}`);
        } else {
            console.log(`❌ 授权码无效或签名已被篡改！`);
        }
        process.exit(res.valid ? 0 : 1);
    }

    const editionIdx = args.findIndex(a => a === "--edition" || a === "-e");
    const edition = (editionIdx !== -1 && args[editionIdx + 1]) ? args[editionIdx + 1].toUpperCase() : "PRO";

    const countIdx = args.findIndex(a => a === "--count" || a === "-n");
    const count = (countIdx !== -1 && args[countIdx + 1]) ? (parseInt(args[countIdx + 1], 10) || 1) : 1;

    const outIdx = args.findIndex(a => a === "--out" || a === "-o");
    const outFile = (outIdx !== -1 && args[outIdx + 1]) ? path.resolve(process.cwd(), args[outIdx + 1]) : null;

    ensureKeyPair();
    console.log(`\n💎 Metrix Ed25519 非对称商用授权码签发器 (v2.0)`);
    console.log(`====================================================`);
    console.log(`正在签发 ${count} 个 [${edition}] 授权码...\n`);

    const keys = [];
    for (let i = 0; i < count; i++) {
        const k = signLicenseKey(edition);
        keys.push(k);
        console.log(`${(i + 1).toString().padStart(2, " ")}. ${k}`);
    }

    if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, keys.join("\n") + "\n", "utf8");
        console.log(`\n📁 已批量导出至卡密文件: ${outFile} (可直接粘贴至爱发电 / Gumroad 自动发卡库存)`);
    }
    console.log(`\n校验命令: node tools/generate_license.js --verify <KEY>\n`);
}

module.exports = {
    ensureKeyPair,
    signLicenseKey,
    verifyLicenseKey
};
