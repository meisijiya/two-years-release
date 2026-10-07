# Release 截图

这 5 张 PNG 是**给公开仓库的 README 用的产品图**，由 `scripts/make-release.mjs`
复制进产物包的 `docs/screenshots/`。

## 为什么它们看起来「到处都是 `【改这里：…】`」

因为它们拍的是**占位符化产物本身**跑起来的样子。

这是刻意的。README 上给二次开发者看图，最有说服力的正是「**你拿到的就是这个**」：
每一处 `【改这里：键名】` 都在告诉他这里要换成自己的内容。换成一份「填好文案」的
截图反而会骗人 —— 那是**你**的礼物站，不是他装上后能看到的。

## 零真实内容是构造保证，不是「看着没问题」

| 内容从哪来 | 为什么不可能是真实内容 |
|---|---|
| 界面文案 | 产物里 `src/copy.js` 的 **175 个字符串叶子全是占位符**（构建期逐叶 import 自证，见 `make-release.mjs` 的「逐叶自证」那一步） |
| 照片 | `scripts/e2e/seed.mjs` 生成的占位块（`door-photo-1`、`shared-1` …），不是任何真照片 |
| 身份代号 / 预填选项 / 地名 | 构建期被占位符化，`scripts/release-check.mjs` 有判据盯着这 6 个词零出现 |
| 正文里的 `MK-…` | e2e 的标记法（`docs/evidence/markers.json`），用来点名「这段是种子里来的」 |

⚠️ **所以「用眼睛看一遍觉得没问题」在这里是多余的步骤** —— 它证明不了什么，
因为不存在需要人眼判断的环节。真要改判据，去改 `release-check.mjs` 的那 6 个词。

## 怎么重新生成

需要一个**真 Chrome**（截图走 DevTools 协议），步骤：

```bash
# 1) 产物解到独立目录并装依赖
node scripts/make-release.mjs --tar
tar -xzf .scratch/release/two-years-release.tgz -C /tmp/pkg && cd /tmp/pkg && npm ci

# 2) 种一份数据 + 起两个实例（一个开门前、一个开门后）
node --import ./test/preload-secrets.mjs scripts/e2e/seed.mjs --dir .shot-data --photos 9 --shots 6
node --import ./test/preload-secrets.mjs _shot-server.mjs .shot-data 8399 unlocked   # 阅读流
node --import ./test/preload-secrets.mjs _shot-server.mjs .shot-data 8400 locked     # 布置台

# 3) Chrome 打开 → 登录（门牌 = 【改这里：doorCode】，生日 = 测试口令）→ 整页截图
#    ⚠️ 截图前把 position:sticky/fixed 临时改成 static：
#       整页截图会把视口「拉长」，sticky 顶栏会停在中途盖住正文（实测盖掉了 options[2]/[3]）。
#       那是渲染伪影，改掉它拍出来的才是真实布局。

# 4) 裁成成品（用比例而不是绝对像素，换机器也对应同一块内容）→ 放回本目录
```

第 3 步的 sticky 处理与第 4 步的裁切比例，实现在一次性的 `.scratch/crop-shots.mjs` 里
（不在版本库里，因为它依赖本机 Chrome）。

## 已知的取舍

- **宽度统一压到 1100px**：原图 1899px 宽会让 README 横向溢出。
- **PNG 而不是 WebP**：GitHub README 两者都渲染，PNG 兼容性更稳，代价是包大约 0.85MB。
- **布置台那张偏长（2584px）**：它一屏要装下引导 + 六条预填 + 输入框 + 第一张卡；
  再压就只剩标题了。