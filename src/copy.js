/**
 * 文案唯一数据源 —— 全站每一个**人会读到**的字都在这里。
 *
 * 形状是纯数据：一个嵌套对象，没有一行逻辑。换文案只改这个文件，
 * 然后跑 `npm run build:copy` 重新生成浏览器侧那份；渲染代码一行都不用动。
 *
 * ── 分工：门禁保证「键一定在」，运行时**故意不抛** ──────────────────
 *   `scripts/check-copy.mjs`（挂在 `npm run check` 上）在构建期静态核对
 *   public/app.js 与 scripts/export-standalone.mjs 里取到的每一个键，
 *   缺一个就退出非 0。所以生产环境取到的一定是真字符串。
 *   既然门禁已经兜住了「键缺失」，运行时**不再为它抛异常**：
 *   10-5 当天宁可某一处显示空字，也不要整页白屏。
 *   降级可接受，白屏不可接受——这是这一层刻意的分工，不是漏了防御。
 *
 * ── 什么不进这个文件 ──────────────────────────────────────────────
 *   · 代码标识符、API 路径、DOM 选择器、CSS 类名（那些是结构，不是文案）
 *   · 角色代号本身：「【改这里：doorCode】」「【改这里：heroCode】」是 person 表里的 code，
 *     改它要动数据库和审计。它们**出现时的措辞**（【改这里：girlfriend】 / 【改这里：boyfriend】、
 *     用来拼「【改这里：heroCode】 给 你 的」的那个「给 你 的」）属于文案，在这里。
 *   · 任何用户内容。`esc(userInput)` 是数据不是文案，由调用方自己转义后传进来。
 *
 * ── 写法约定 ──────────────────────────────────────────────────────
 *   · 带插值的用 `{name}` 占位符，由调用方传值（见 public/app.js 的 `C()`）。
 *     刻意**不用函数**：这样整个对象是纯 JSON，能逐字节可复现地生成
 *     public/copy.js，两个渲染器拿到的结构也保证完全一致。
 *   · 值的前后**不留空白**。元素之间的空格写在模板里——
 *     否则有人在编辑器里手抖删掉一个尾随空格，界面上就少半个字间距。
 *     scripts/check-copy.mjs 会把「值带首尾空白」判为违规。
 *   · HTML 实体（`&nbsp;`）留在值里：它决定最终渲染出的那几个空格，
 *     属于「这句话长什么样」的一部分。
 */
export const COPY = {
  /* 浏览器标签页上的标题。正式站写在 public/index.html 的 <title>，
     应急页写在产物的 <title>——两边都由这一个值决定，check-copy 盯着它们一致。 */
  meta: {
    title: "【改这里：title】",
  },

  /* 三个屏共用一个主标题（封印页 / 阅读流首屏 / 应急页首屏）。
     它们今天都是「两年了」，而且曾经真的漂移过（正式站与应急页各写各的），
     所以合成一个键：键一多就会各自改。 */
  hero: {
    title: "【改这里：title】",
    kicker: "【改这里：kicker】",
  },

  /* 共用的小词：两屏的返回按钮是同一句 */
  nav: {
    back: "【改这里：back】",
  },

  /* ══════════════ 日期的写法（年月日那几个字）══════════════
     「2024 年 10 月 5 日」里的年 / 月 / 日是人读的，不是格式噪音。
     数字是算出来的（不读设备时钟，见 src/clock.js），但那几个字属于文案。 */
  date: {
    full: "【改这里：full】",
    monthDay: "【改这里：monthDay】",
  },

  /* ══════════════ 封印页 ══════════════ */
  seal: {
    /* ⚠️ 这一行是手写字面量，**不从开门时刻推**——全站就这一处不同源。
       开门时刻一改，它就会静默说谎（见 to-questionnaire-copy.md 第 2 条）。 */
    dates: "【改这里：dates】",
    envelope: "【改这里：envelope】",
    tape: {
      locked: "【改这里：locked】",
      unlocked: "【改这里：unlocked】",
    },
    note: {
      locked: "【改这里：locked】",
      unlocked: "【改这里：unlocked】",
    },
    kickerUnlocked: "【改这里：kickerUnlocked】",
    nudge: {
      locked: "【改这里：locked】",
      unlocked: "【改这里：unlocked】",
    },
    cta: {
      anonymous: "【改这里：anonymous】",
      authed: "【改这里：authed】",
    },
    foot: "【改这里：foot】",
    countdown: {
      units: ["【改这里：units[0]】", "【改这里：units[1]】", "【改这里：units[2]】", "【改这里：units[3]】"],
      /* 倒计时归零之后那一格变成它（10-5 当天她看到的就是这个） */
      opened: "【改这里：opened】",
    },
  },

  /* ══════════════ 身份页 ══════════════ */
  identity: {
    title: "【改这里：title】",
    hint: "【改这里：hint】",
    /* 身份卡上代号下面那个小标签。写的是**对方**的角色，不是自己的。 */
    roles: {
      door: "【改这里：door】",
      hero: "【改这里：hero】",
    },
  },

  /* ══════════════ 密码页 ══════════════ */
  pass: {
    hint: "【改这里：hint】",
    placeholder: "【改这里：placeholder】",
    submit: "【改这里：submit】",
    a11y: "【改这里：a11y】",
  },

  /* ══════════════ 布置台 ══════════════ */
  desk: {
    chip: {
      unlocked: "【改这里：unlocked】",
      /* 后面紧跟一个 <b data-cd> 倒计时，元素之间的空格写在模板里 */
      locked: "【改这里：locked】",
    },
    title: "【改这里：title】",
    lead: {
      top: "【改这里：top】",
      unlocked: "【改这里：unlocked】",
      locked: "【改这里：locked】",
    },
    /* 「已折好 <b>3</b> 件 ·」中间那个数字要加粗并用等宽数字
       （.desk .meta b），所以这句话被 <b> 分成两截，各存各的。 */
    countLead: "【改这里：countLead】",
    countTail: "【改这里：countTail】",
    logout: "【改这里：logout】",
    empty: "【改这里：empty】",

    /* 操作引导（2026-10-03 晚新增）。
       为什么必须有：界面上原来只有「照 片」「写 几 句」「撤 回」这几个词，
       没有一处说她按下会发生什么、能不能反悔。其中「撤 回」这一条尤其要紧 ——
       它已经是**真删**（行、photo 行、盘上文件一起没），而按钮上只写两个字，
       她按之前不可能知道这一点。
       最后一条单独拆出来：它带 {human} 占位符，而数组里的字符串过不了插值
       （cp() 碰到对象/数组是原样返回），放进去 {human} 会原样显示在屏幕上。 */
    guide: {
      title: "【改这里：title】",
      items: [
        { k: "【改这里：k】", v: "【改这里：v】" },
        { k: "【改这里：k】", v: "【改这里：v】" },
        { k: "【改这里：k】", v: "【改这里：v】" },
        { k: "【改这里：k】", v: "【改这里：v】" },
      ],
      seal: {
        k: "【改这里：k】",
        v: "【改这里：v】",
      },
    },
  },

  /* ══════════════ 底部常驻添加栏 ══════════════ */
  addbar: {
    plus: "【改这里：plus】",
    photo: {
      title: "【改这里：title】",
      desc: "【改这里：desc】",
    },
    text: {
      title: "【改这里：title】",
      desc: "【改这里：desc】",
    },
  },

  /* ══════════════ 信卡（布置台与阅读端共用同一个渲染器）══════════════ */
  card: {
    /* 留 言 / 照 片 · 第 {n} 张 —— 编号是自动的，不进文案 */
    kind: {
      photo: "【改这里：photo】",
      text: "【改这里：text】",
    },
    /* 封条：布置台「封存中」，阅读端「已送达」。同一张卡，语气由 mode 决定。 */
    stamp: {
      editing: "【改这里：editing】",
      reading: "【改这里：reading】",
    },
    captionHint: "【改这里：captionHint】",
    ops: {
      withdraw: "【改这里：withdraw】",
      writeOne: "【改这里：writeOne】",
      editOne: "【改这里：editOne】",
    },
  },

  /* ══════════════ 留言编辑器（写新留言 / 改已有留言）══════════════ */
  composer: {
    new: {
      title: "【改这里：title】",
      placeholder: "【改这里：placeholder】",
      submit: "【改这里：submit】",
    },
    edit: {
      title: "【改这里：title】",
      submit: "【改这里：submit】",
    },
    cancel: "【改这里：cancel】",
    a11y: "【改这里：a11y】",
  },

  /* ══════════════ 约定（工单 05）══════════════ */
  wish: {
    /* 布置台上是「折」，阅读端是「看」——两屏的写法本来就不同，各存各的 */
    deskTitle: "【改这里：deskTitle】",
    /* 预填选项：2026-10-03 由本人逐条给定，替换掉原先抄 prototype/ui-v4.html 的那六条。
       顺序按本人给的原顺序（【改这里：place】 / 搬到一起住 / 学会做那道菜 / 海边日出 / 玩游戏 / 按摩）。
       **选项不是围栏**：后面始终跟着一个自己写的输入框。
       这六条只在布置台出现 —— 应急页只显示「已经选好的那一条」（standalone.wishTitle），
       不列预填项，所以这里改一处就够。 */
    options: [
      "【改这里：options[0]】",
      "【改这里：options[1]】",
      "【改这里：options[2]】",
      "【改这里：options[3]】",
      "【改这里：options[4]】",
      "【改这里：options[5]】",
    ],
    own: {
      placeholder: "【改这里：placeholder】",
      submit: "【改这里：submit】",
      a11y: "【改这里：a11y】",
    },
    say: {
      done: "【改这里：done】",
      idle: "【改这里：idle】",
    },
    /* ── 阅读端那一屏 ── */
    reading: {
      title: "【改这里：title】",
      hint: "【改这里：hint】",
      empty: "【改这里：empty】",
      note: {
        both: "【改这里：both】",
        missing: "【改这里：missing】",
      },
    },
  },

  /* ══════════════ 阅读流 ══════════════ */
  reading: {
    anniversary: "【改这里：anniversary】",
    cue: "【改这里：cue】",
    twoYearsTitle: "【改这里：twoYearsTitle】",
    zoomHint: "【改这里：zoomHint】",
    blessing: {
      /* 这里原来有一个小标题：先是「这 {days} 个日夜」（渲染成「这 731 个日夜」），
         10-03 换成「说点正经的」，当天又被去掉。
         去掉的理由：共同层这段话是**两个人一起回望**，上面再挂一句「说点正经的」
         这种自嘲的抬头，等于替他们先开了口；而且它和下面那行「一共 {days} 天」
         说的是同一个数，本来就在挨着报两遍。
         这个键连同三处 `cp("reading.blessing.title")` 调用点（app.js ×2、export ×1）
         一起删干净，**不留空串** —— `.letter-big .h` 带 20px 下边距，
         留一个空标题会在正文上方留一道空隙。
         天数仍由下面 reading.range 那行守，断言也在那行。 */
      empty: "【改这里：empty】",
    },
    range: "【改这里：range】",
    turn: {
      kicker: "【改这里：kicker】",
      title: "【改这里：title】",
      hint: "【改这里：hint】",
    },
    letter: {
      title: "【改这里：title】",
      empty: "【改这里：empty】",
    },
    photos: {
      title: "【改这里：title】",
      count: "【改这里：count】",
      empty: "【改这里：empty】",
    },
    tailTitle: "【改这里：tailTitle】",
    foot: "【改这里：foot】",
  },

  /* ══════════════ 观察者入口（测试专用 · CONSTRAINTS §2b）══════════════
     唯一一处会一次显示双方内容 + 共同层的地方，而它**不在任何导航里**：
     入口是 URL hash（#observe），它不会发到服务器、不进访问日志；界面上也没有任何一处
     链到它、也没有一个字写出它。理由、边界与撤销方式见 CONSTRAINTS.md §2b。

     共同层的九宫格、祝福语与日期区间**复用** reading.* 的键而不是另写一份措辞 ——
     观测到的那句话必须和 TA 收到的那句话是同一句。 */
  observe: {
    title: "【改这里：title】",
    hint: "【改这里：hint】",
    pin: "【改这里：pin】",
    /* 刻意与 pass.submit（也是「进 去」）错开：这扇门要是哪天漏进正常那四屏，
       两处一模一样的话，没人会发现。旁路自己的词必须一眼认得出是旁路。 */
    enter: "【改这里：enter】",
    leave: "【改这里：leave】",
    shared: "【改这里：shared】",
    side: "【改这里：side】",
    wishes: "【改这里：wishes】",
    /* 某一侧一条都没有时的留白，与布置台同一个语气 */
    empty: "【改这里：empty】",
    wishEmpty: "【改这里：wishEmpty】",
    err: {
      empty: "【改这里：empty】",
      offline: "【改这里：offline】",
      gone: "【改这里：gone】",
    },
  },

  /* ══════════════ 图没读出来时那块占位块 ══════════════
     正式站与应急页用的是**同一个词**——它们曾经各写各的
     （正式站「照 片」，应急页「照片 3」），现在同源，漂不动了。 */
  placeholder: {
    shot: "【改这里：shot】",
    photo: "【改这里：photo】",
    bub: "【改这里：bub】",
    pending: "【改这里：pending】",
  },

  /* ══════════════ 报错与系统提示 ══════════════ */
  err: {
    offline: "【改这里：offline】",
    noSession: "【改这里：noSession】",
    locked: "【改这里：locked】",
    incomplete: "【改这里：incomplete】",
    gone: "【改这里：gone】",
    emptyBirthday: "【改这里：emptyBirthday】",
    wrongBirthday: "【改这里：wrongBirthday】",
    emptyText: "【改这里：emptyText】",
    notImage: "【改这里：notImage】",
    noCanvas: "【改这里：noCanvas】",
    decodeFailed: "【改这里：decodeFailed】",
    generic: "【改这里：generic】",
    loggedOut: "【改这里：loggedOut】",
    /* ---- 服务端发的提示（src/routes.js 直接读这里）----
       它们不在浏览器里，却**会显示在屏幕上**：`hint` 字段被前端 `r.data.hint`
       原样渲染出来。所以它们同样算文案，同样归这一个数据源管。
       不搬的后果很具体：她改了密码页那句，服务端那句还是旧的，
       而服务端那句恰好是**平时真正显示的那一条**（前端兜底只在服务端没给 hint 时才出现）。 */
    server: {
      wrongBirthday: "【改这里：wrongBirthday】",
      notImage: "【改这里：notImage】",
      // 观察者口令的提示（同上：hint 会被原样渲染到屏幕上，所以归这一个数据源管）。
      // 这条是给「知道自己在测试」的人看的，不给两个人中的任何一个看 ——
      // 观察者入口不出现在任何导航里，路由本身也不从 UI 可达。
      wrongObserver: "【改这里：wrongObserver】",
    },
  },

  /* 操作完成后顶部冒出来的那一句 */
  toast: {
    saved: "【改这里：saved】",
    /* 原来这句第二段是「数据库里留着痕迹。」—— 那是软删时代的实话。
       撤回改成硬删（routes.js 的 DELETE /api/entry/:id）之后它变成**假话**，
       而用户恰恰是在这种提示语上判断「我删干净了吗」，所以必须一起改。 */
    withdrawn: "【改这里：withdrawn】",
    wishSaved: "【改这里：wishSaved】",
    photoUploaded: "【改这里：photoUploaded】",
    compressing: "【改这里：compressing】",
  },

  /* 断网提示条（建在 #app 之外） */
  offline: {
    bar: "【改这里：bar】",
    retry: "【改这里：retry】",
  },

  /* ══════════════ 背景音乐（2026-10-03 新增）══════════════
     三块分开的原因：按钮上写的、读屏念的、提示条上写的**不是同一句话**。
     `on` / `off` 是按钮上那三个字；`a11y*` 是 VoiceOver 念的
     （念「音 乐 开」等于没告诉用户按下去会发生什么）；
     `blocked` 只在被浏览器拦下、还没起播时出现，起了播就换成 `hint`。 */
  music: {
    on: "【改这里：on】",
    off: "【改这里：off】",
    a11yOn: "【改这里：a11yOn】",
    a11yOff: "【改这里：a11yOff】",
    /* 起播后给一句「嫌吵可以关」——她要读很久，音乐是她自己在场的声音。
       ⚠️ 这句话原来写的是「点右上角关掉」。音乐开关收进右侧那条「收 纳」之后，
       右上角那儿已经什么都没有了 —— 留着就是一句指不到地方的假话。 */
    hint: "【改这里：hint】",
    /* 自动播放被浏览器拦下时：必须有一次用户手势，这是浏览器的硬规则不是我们的选择 */
    blocked: "【改这里：blocked】",
  },

  /* ══════════ 收纳（2026-10-03 晚新增）══════════
     收起态 = 右侧边缘一条竖排把手；展开 = 一小块面板，音乐开关与退出都在里面。

     为什么收纳而不是换个位置：早先音乐开关是一颗**常驻右上角**的胶囊，
     它正好压住布置台顶部右上那只装饰熊与那条倒计时（用户 2026-10-03 截图确认）。
     换到中下方会撞添加栏；只有「收起来」是唯一既不挡、又随时能拿到的形状。

     退出也在这里，而不是各屏各放一个：布置台原来在「已折好 N 件 ·」后面
     有一个行内退出，而**解封后的阅读流一个都没有** —— 那条路进去之后出不来。
     收进同一个组件，两种状态自然都有。 */
  dweller: {
    tab: "【改这里：tab】",
    a11yOpen: "【改这里：a11yOpen】",
    a11yClose: "【改这里：a11yClose】",
    title: "【改这里：title】",
    musicLabel: "【改这里：musicLabel】",
    logout: "【改这里：logout】",
  },

  /* ══════════════ 无障碍：页面上看不见，读屏软件念出来的 ══════════════ */
  a11y: {
    removeCard: "【改这里：removeCard】",
    zoomShot: "【改这里：zoomShot】",
    lightbox: "【改这里：lightbox】",
    prev: "【改这里：prev】",
    next: "【改这里：next】",
    close: "【改这里：close】",
  },

  /* ══════════════ 应急单文件页独有的那几句 ══════════════
     与正式站同源的词（hero / turn / letter / tail / wish…）不在这里重复，
     两边取的是同一批键——这正是「两个渲染器不可能漂移」的落点。 */
  standalone: {
    range: "【改这里：range】",
    /* 与正式站的 reading.turn.kicker（「给 你 的」）**故意不同**：
       应急页写「留 给 你 的」。两个都是定稿措辞，合成一个反而会改掉一边。 */
    giftKicker: "【改这里：giftKicker】",
    blessingEmpty: "【改这里：blessingEmpty】",
    noLetter: "【改这里：noLetter】",
    photosTitle: "【改这里：photosTitle】",
    noPhotos: "【改这里：noPhotos】",
    wishTitle: "【改这里：wishTitle】",
    noWish: "【改这里：noWish】",
    foot: "【改这里：foot】",
    /* 防呆水印：只在你误操作、在开门时刻之前强行导出时出现。
       这句不要改——它不出现的时候没人看得见，出现的时候是在提醒操作的人。 */
    watermark: "【改这里：watermark】",
    /* 应急页的 alt **故意保留编号**：念「照片 3」才说得出这是第几张。
       它与可见占位块（placeholder.photo，不带编号）不是一回事，别一起改。
       九宫格那一格的 alt 是另一个词（合照 N，不是 照 片 N）——两张图不是一回事。 */
    photoAlt: "【改这里：photoAlt】",
    gridAlt: "【改这里：gridAlt】",
  },
};
