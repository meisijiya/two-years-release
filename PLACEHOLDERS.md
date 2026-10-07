# 占位符清单 —— 二次开发者要自己填的东西

这个包是**纯净版**：里面没有你的照片、你的文案、你的生日。
按下面这张表填完之后，它就是你自己的礼物站。

| # | 位置 | 放什么 | 必需 |
|---|---|---|---|
| 1 | `photos/together/01.jpg` … `09.jpg` | 共同层九宫格的 **9 张合照**。目录要自己建（它在 `.gitignore` 里） | 必需 |
| 2 | `photos/together/blessing.txt` | 共同层那一段**祝福语**，纯文本 | 必需 |
| 2b | `src/shared.js` 的 `DEFAULT_BLESSING` | 同上的**兜底文案**。正式内容以 `blessing.txt` 为准，这个只是文件没读到时的兜底，两处语气不一致会先露馅 | 必需 |
| 3 | `data/two-years.db` | **不手写**。跑下面那条 `seed:shared` 建出来 | 必需 |
| 4 | 服务器 `/etc/two-years/two-years.env` | `DOOR_PASSWORD` / `HERO_PASSWORD` / `OBSERVER_PASSWORD` | 必需 |
| 5 | `src/clock.js` 的 `UNLOCK_AT` | **开门时刻**，必须带时区偏移 | 必需 |
| 6 | `src/copy.js` | 全站文案：代号、称呼、布置台与阅读流的每一句话。改完跑 `npm run build:copy` | 必需 |
| 7 | `public/bgm.mp3` | 生日 BGM。**纯净包里没有这个文件**（它是一首具体的歌，属于「两个人的东西」）。放置你自己的 mp3 后音乐就能响 | 可选 |
| 8 | `deploy/nginx/*.conf` | 你的域名、证书路径 | 必需 |

## 上手顺序

```bash
npm ci
npm run verify                     # 先确认这份代码在你自己机器上是绿的

# 填 1、2 两项，然后播种共同层（走真实写入路径，产出库与照片）：
node scripts/seed-shared.mjs --photos photos/together

# 填 5、6 两项；改完文案记得：
npm run build:copy

npm start                          # 默认只绑 127.0.0.1，前面放 nginx 反代
npm run ops:check -- --base http://127.0.0.1:8300 \
  --db ./data/two-years.db --photos-dir ./data/photos
```

## 三条不要碰的地方

1. **`DATA_DIR` 绝不能落在 `public/` 里面。** 那样照片会被 `express.static`
   **零鉴权直出**，时间锁当场作废且不报任何错。`createApp` 在启动时硬断言这件事，
   不满足**直接起不来** —— 这是故意的，不是 bug。
2. **`UNLOCK_AT` 必须带时区偏移。** 写 `new Date("2026-10-05")` 会按 UTC 解析，
   比东八区的 00:00 **提前 8 小时开门**。见 `CONSTRAINTS.md` §1。
3. **密码 = 对方的生日**，这是产品定义。剥掉非数字后同时接受 4 位月日与
   8 位完整生日（所以 `0607` 与 `20150607` 是同一个人的两种写法）。
   **这个值只放 env 文件，绝不写进源码或测试** —— 仓库里出现它就是事故。

### 关于 `public/bgm.mp3` 缺失时的真实行为

**音乐按钮不会自动消失。** `public/app.js` 无条件建 `<audio src="/bgm.mp3">`，
文件不在时加载失败会被记成 `MUSIC.blocked`，于是按钮照常显示、
点了却永远不响（`musicSync()` 只在 `want && !playing && blocked` 时
显示 `copy.js` 里 `music.blocked` 那句提示）。

所以两个选择：① 放一个你自己的 mp3 进去（推荐）；② 不想有音乐就把
`copy.js` 里 `music.*` 那几个键改成空串，并从 `public/index.html`
去掉音乐按钮。**别以为放着不管就是「没音乐」** —— 那是一个点不开的按钮。

## 别把私人的东西提交进版本库

`.gitignore` 已经挡住 `photos/`、`data/`、`.observer-key`、`.log-salt`、
`*.db`、`.scratch/`，并且 `npm run check` 里的 `check-secrets.mjs`
会扫私钥、公网 IP、完整生日口令、SSH 主机别名、云实例 ID 与真实域名。
**别绕过它，也别给它加豁免。**
