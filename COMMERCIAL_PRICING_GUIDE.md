# 💎 Metrix 商业化运营与自动发卡实战指南 (v2.0 Ed25519 商用正式版)

本文档为 **Metrix: 思源笔记多平台矩阵一键分发套件** 的商业化定价策略、Ed25519 非对称加密卡密生成、电商自动发卡配置与思源集市上架全流程手册。

---

## 一、 商业版本梯度与定价策略

### 1. 免费社区版 (Community Free Edition) — 集市获客漏斗
- **价格**：**¥0** / 永久免费（上架思源笔记官方集市，最大化自然搜索与安装量）
- **核心权益与转化卡点**：
  - 支持**微信公众号 AppID/AppSecret 官方草稿箱直连** + 6 大内容社区草稿箱连接；
  - **单次仅允许发布 1 个平台，且每日限免费使用 3 次**（既能让新用户完整跑通任一平台的真实草稿推送建立信任，又在多平台日更场景下形成极强的 Pro 转化驱动力）；
  - 品牌署名与封面顶部胶囊标语锁定为默认预设。

### 2. 终身专业版 (Lifetime Pro) — 核心主力成交款
- **价格**：**¥49**（海外定价：**$7.99**）/ 一次买断，终身授权
- **解锁权益**：
  - **全网 7 大平台不限次数一键并行并发齐发（含公众号 API 直连）**；
  - **解锁专属作者署名与封面顶部胶囊标语深度自定义**；
  - **解锁 PicGo 本地接口、ImgBB 云图床、GitHub + jsDelivr CDN 图床全自动上传与外链替换**；
  - 纯离线 Ed25519 数字签名激活，永久有效，零联网鉴权、零隐私收集。

### 3. 工作室团队版 (Studio / Team Edition) — 高客单增值款
- **价格**：**¥129**（海外定价：**$19.99**）/ 终身买断
- **解锁权益**：
  - 包含 Pro 版全部能力，界面专属显示「🏢 Metrix 工作室团队版 (已永久授权)」尊享标识；
  - 授权最多 5 台设备 / 多账号自媒体矩阵商业团队使用。

---

## 二、 Ed25519 非对称数字签名发卡体系（防破解核心）

Metrix v2.0 已全面升级为 **Ed25519 非对称椭圆曲线数字签名**，彻底移除早期对称哈希算法与任何体验测试码后门：
- **私钥隔离存放**：唯一签名私钥保存在本地 `.private/ed25519_private.pem`（权限 `0600`，已被 `.gitignore` 严格排除，**绝对禁止上传至 GitHub 或打入插件包**，建议您在个人密码管理器或加密云盘中额外备份一份该私钥文件）；
- **客户端仅含公钥**：分发给用户的 `siyuan-plugin/index.js` 仅内置 Public Key (`MCowBQ...`)。即使逆向全部前端源码，没有您的私钥在数学上也无法伪造任何一个合法的 `MXP2-PRO-...` 激活码！

### 1. 首批已生成的现成卡密库存（可直接复制上架）
项目已在本地 `.private/` 目录为您预生成首批可直接售卖的正版卡密：
- **终身专业版 (50 张，单价 ¥49)**：`.private/stock_pro_50.txt`
- **工作室团队版 (10 张，单价 ¥129)**：`.private/stock_team_10.txt`

### 2. 后续随时补充库存命令
当首批 50 张售罄后，在项目根目录执行以下命令即可秒级增发新卡密：

```bash
# 增发 100 张【终身专业版】卡密并导出文本（每行一个，直接粘贴进发卡平台）
node tools/generate_license.js --edition PRO --count 100 --out .private/stock_pro_batch2.txt

# 增发 20 张【工作室团队版】卡密
node tools/generate_license.js --edition TEAM --count 20 --out .private/stock_team_batch2.txt
```

### 3. 售后人工验真命令
若买家咨询某个激活码是否有效或属于哪个版本，运行：
```bash
node tools/generate_license.js --verify "MXP2-PRO-XXXXXXXX-..."
```

---

## 三、 电商自动发卡 5 分钟配置（零服务器成本）

插件内默认购买链接已指向：`https://afdian.com/item/e617d03cddba11f1bb3552540025c377`  
> 如需更换为您自己的面包多 / 鲸发卡 / Gumroad / LemonSqueezy 商品详情页，只需修改 `siyuan-plugin/index.js` 顶部的常量 `PURCHASE_PRO_URL` 并运行 `bash scripts/package_release.sh` 重新打包即可。

### 国内首选：爱发电 (Aifadian) / 面包多自动发卡
1. 登录 [爱发电创作者后台](https://afdian.com) -> **「电铺 / 商品管理」** -> **「发布商品」**；
2. **商品 1（主力款）**：
   - 标题：`Metrix 思源笔记自媒体矩阵一键分发 · 终身专业版激活码`
   - 价格：`49.00` 元
   - 发货方式：选择 **「自动发货 / 卡密（一人一码）」**
   - 卡密库存：打开 `.private/stock_pro_50.txt`，将所有 `MXP2-PRO-...` 行复制粘贴进去；
3. **商品 2（高客单团队款）**：
   - 标题：`Metrix 思源笔记矩阵分发 · 工作室团队版授权 (5设备商用)`
   - 价格：`129.00` 元
   - 卡密库存：粘贴 `.private/stock_team_10.txt` 中的 `MXP2-TEAM-...` 卡密；
4. 买家付款后平台 24 小时全自动秒发卡密，用户在思源笔记按 `⌥M` -> 点击右上角 **「💎 升级 Pro」** 粘贴即可秒级激活！

---

## 四、 一键构建与上架思源笔记官方集市流程

每次发版只需运行一行命令：
```bash
bash scripts/package_release.sh
```
该脚本会自动执行：
1. 调用 Terser AST 压缩混淆浏览器伴侣源码，产出 `browser-companion/dist/metrix-companion.zip` 并同步内嵌至 `siyuan-plugin/companion/metrix-companion.zip`；
2. 清理冗余开发文件，严格按思源集市规范生成 `release/package.zip`（用于上传 GitHub Release 供思源集市拉取）与 `release/metrix-companion-v2.0.0.zip`。

### 提交思源集市步骤：
1. 在 GitHub 创建公开仓库 `lsqingfeng/siyuan-metrix`（注意 `.gitignore` 已自动保护 `.private/` 私钥不被上传），推送代码；
2. 在该仓库创建 GitHub Release（Tag 为 `v2.0.0`），将 `release/package.zip` 作为 Release 附件上传；
3. Fork 官方集市仓库 [siyuan-note/bazaar](https://github.com/siyuan-note/bazaar)，在根目录 `plugins.txt` 末尾追加一行 `lsqingfeng/siyuan-metrix`（单独一行，无逗号、无多余空行）并发起 Pull Request，CI 自动校验通过合并后即可正式出现在全球思源笔记用户的「集市 -> 插件」列表中！
