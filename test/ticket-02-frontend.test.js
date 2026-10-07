/**
 * 工单 02 · 前端契约测试
 *
 * 这一条把时间锁从「服务端保证」延伸成「界面保证」（CONSTRAINTS.md §1）：
 * 服务端 404 了但前端还渲染着占位文案，同样是破的。
 *
 * 缝：真 DOM（jsdom 载入 public/index.html 真脚本）+ 假网络（fetch 被打桩）。
 * 断言只落在界面上看得见的文本与渲染出来的元素集合上，不碰内部实现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_FILE = path.join(ROOT, "public", "index.html");
const CSS_FILE = path.join(ROOT, "public", "style.css");

/* 我自己的两条 */
const E1 = { id: "e1", kind: "text", body: "两年了，还是会因为一点小事开心很久。", ord: 1, created: 1759000000000, photo: null };
const MINE = [E1];
/* 对方的条目：未解锁时 theirs 恒为 []，这里**故意塞一条假的**，
   用来证明前端不是「只是没收到」，而是根本没有把它画出来的代码路径。 */
const FAKE_THEIRS = { id: "x-theirs", kind: "text", body: "假对方的正文，一个字都不该出现在界面上", ord: 1, created: 1759000000000, photo: null };
const ME = { id: "door", code: "【改这里：doorCode】", role: "【改这里：girlfriend】", unlocked: false, count: 1 };

const LOCKED_STATUS = {
  status: 200,
  body: { unlocked: false, unlockAt: 1791129600000, unlockLabel: "2026-10-05T00:00:00+08:00", now: 1791129599000 },
};
const UNLOCKED_STATUS = { ...LOCKED_STATUS, body: { ...LOCKED_STATUS.body, unlocked: true } };

const LOCKED_ROUTES = {
  "GET /api/status": LOCKED_STATUS,
  "GET /api/me": { status: 200, body: ME },
  "GET /api/entry": { status: 200, body: { mine: MINE, theirs: [FAKE_THEIRS] } },
};
const UNLOCKED_ROUTES = {
  "GET /api/status": UNLOCKED_STATUS,
  "GET /api/me": { status: 200, body: { ...ME, unlocked: true } },
  "GET /api/entry": { status: 200, body: { mine: MINE, theirs: [FAKE_THEIRS] } },
};

/**
 * 「已开门时」应用**真的会产出**的串。
 *
 * 这张表必须从代码里读出来，不能猜。原来那份
 * `["我们的两年","合照","祝福","约定","已解锁"]` 里每一个串在**任何**状态下都不产生，
 * 于是断言恒真——把开门时刻改成过去、界面完全开门，它照样绿，
 * 对它想防的失效模式零鉴别力。下面那条「对照」测试就是给这张表上牙的。
 */
const UNLOCKED_SEAL = ["已 经 开 启", "已经开了"];
const UNLOCKED_DESK = ["已经送到 TA 手上"];
/** 未解锁时这几串一个都不许出现 */
const UNLOCKED_ONLY = [...UNLOCKED_SEAL, ...UNLOCKED_DESK];

/** 打桩 fetch：记录调用，返回真 Response。setInterval 计数用来抓「重绘时建定时器」。
 *  用 fromFile + resources:"usable" 让 index.html 真的去加载 public/app.js：
 *  这样 body.textContent 里只有界面上看得见的文本 —— 脚本源码不算界面文案。 */
async function mount(routes) {
  const seen = [];
  const timers = { interval: 0 };
  // 形象素材还没进 public/，图片的加载报错不必污染测试输出
  const dom = await JSDOM.fromFile(HTML_FILE, {
    runScripts: "dangerously",
    resources: "usable",
    virtualConsole: new VirtualConsole(),
    beforeParse(w) {
      const real = w.setInterval.bind(w);
      w.setInterval = (...a) => { timers.interval += 1; return real(...a); };
      w.fetch = async (url, init = {}) => {
        const key = `${(init.method || "GET").toUpperCase()} ${url}`;
        seen.push(key);
        const r = routes[key];
        const status = r ? r.status : 404;
        const body = r && status !== 204 ? r.body : { error: "not_found" };
        return new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      };
    },
  });
  return { dom, seen, timers };
}

async function boot(t, routes) {
  const { dom, seen, timers } = await mount(routes);
  t.after(() => dom.window.close());          // 关窗会清掉那个 setInterval，否则进程不退出
  // 外部脚本是异步加载的，等它把启动缝挂出来；挂不出来说明 index.html 没接上 app.js
  for (let i = 0; i < 200 && !dom.window.__t02; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(dom.window.__t02, "public/index.html 没有跑起 public/app.js（脚本没加载，或加载后没挂 __t02）");
  await dom.window.__t02.ready;
  return {
    win: dom.window,
    doc: dom.window.document,
    seen,
    timers,
    text: () => dom.window.document.body.textContent,
    click(sel) {
      const el = dom.window.document.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      return el;
    },
    fill(sel, value) {
      const el = dom.window.document.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.value = value;
      return el;
    },
    submit(sel) {
      const el = dom.window.document.querySelector(sel);
      assert.ok(el, `界面上找不到 ${sel}`);
      el.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    },
  };
}

/** 事件回调是 async 的，等它把界面画完 */
async function until(pred, msg) {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail(msg);
}

function assertNoLeak(text, where, t) {
  for (const w of UNLOCKED_ONLY) {
    assert.ok(!text.includes(w), `${where}出现了只有已开门才该有的文案「${w}」`);
  }
  assert.ok(!text.includes("假对方的正文"), `${where}把对方的正文画出来了`);
  assert.ok(!text.includes(FAKE_THEIRS.id), `${where}把对方的条目 id 画出来了`);
  t.diagnostic(`${where} 可见文本长度 ${text.length}，抽样：${text.trim().slice(0, 60)}…`);
}

test("对照：已开门时那些串确实会出现——没有这一条，上一条就是恒真式", async (t) => {
  // 这条测试是上面那些断言的**鉴别力来源**。
  // 如果禁用词表里的串是编的（应用任何状态下都不产出），这里就会红。
  const ui = await boot(t, UNLOCKED_ROUTES);
  for (const w of UNLOCKED_SEAL) {
    assert.ok(ui.text().includes(w), `已开门的封印页却看不到「${w}」——禁用词表里的串是编出来的`);
  }
  // 布置台那句只有进了布置台才看得到，所以这张表要盖到两屏
  ui.click('[data-go="desk"]');
  await until(() => ui.text().includes(UNLOCKED_DESK[0]), "已开门时点入口没进布置台");
  for (const w of UNLOCKED_DESK) {
    assert.ok(ui.text().includes(w), `已开门的布置台却看不到「${w}」——禁用词表里的串是编出来的`);
  }
  t.diagnostic(`已开门 可见文本长度 ${ui.text().length}，抽样：${ui.text().trim().slice(0, 80)}…`);
});

test("未解锁时：封印页与布置台都不出现共同层文案、对方内容与开门文案", async (t) => {
  const ui = await boot(t, LOCKED_ROUTES);
  assertNoLeak(ui.text(), "封印页", t);
  assert.ok(ui.text().includes("两年了"), "封印页该有主标题，否则这条断言是空转");

  // 走真实点击进布置台，不直接改内部状态
  ui.click('[data-go="desk"]');
  assert.ok(ui.text().includes(E1.body), "布置台该显示自己的留言，否则后面的断言是空转");
  assertNoLeak(ui.text(), "布置台", t);

  // 「封存中」是布置台的语气，不能被写成「已送达」
  assert.ok(ui.text().includes("封 存 中"), "布置台的封条应是「封存中」");
  assert.ok(!ui.text().includes("已 送 达"), "未解锁的布置台不该出现阅读端的「已送达」");
});

test("封印页有第二条入口：没有会话也能走进布置台", async (t) => {
  const ui = await boot(t, { "GET /api/status": LOCKED_STATUS, "GET /api/me": { status: 401, body: { error: "no_session" } } });
  assert.ok(ui.text().includes("还没到呢"), "封印页该是锁着的");
  assert.ok(ui.text().includes("我先去布置"), "封印页缺第二条入口「我先去布置 →」，她进不去布置台");
  assert.match(ui.text(), /天.*时.*分.*秒/s, "封印页该有指向开门时刻的倒计时");

  // 第一个可点元素（信封）点了只会晃一下，不会把人带走
  ui.click("#box");
  assert.match(ui.text(), /还没到 · .* 才开/, "点信封应该只提示还没到");

  // 第二个可点元素才是真入口
  ui.click('[data-go="who"]');
  assert.ok(ui.text().includes("【改这里：doorCode】"), "身份页该有代号「【改这里：doorCode】」");
  assert.ok(ui.text().includes("【改这里：heroCode】"), "身份页该有代号「【改这里：heroCode】」");
  assertNoLeak(ui.text(), "身份页", t);

  ui.click('[data-who="door"]');
  assert.ok(ui.doc.querySelector("#pin"), "选完身份该进密码页");
  assert.match(ui.text(), /4 位月日、8 位完整生日都行/, "密码页该说清两种生日形态都收");
});

test("倒计时独立 tick：反复 render 不新建定时器", async (t) => {
  const ui = await boot(t, LOCKED_ROUTES);
  assert.equal(ui.timers.interval, 1, "全站只应有一个 setInterval");

  for (let i = 0; i < 5; i++) ui.win.__t02.render();
  assert.equal(ui.timers.interval, 1, "render() 又建了 setInterval —— 原型踩过，每秒泄漏一个");

  // 换屏也不许建：走一遍真实的封印 → 身份 → 密码 → 返回
  const anon = await boot(t, { "GET /api/status": LOCKED_STATUS, "GET /api/me": { status: 401, body: { error: "no_session" } } });
  anon.click('[data-go="who"]');
  anon.click('[data-who="door"]');
  assert.ok(anon.doc.querySelector("#pin"), "该进密码页");
  anon.click('[data-go="who"]');
  anon.click('[data-go="seal"]');
  assert.equal(anon.timers.interval, 1, "换屏时又建了 setInterval");
});

test("同一个 card：mode=read 不渲染撤回角标 / 操作行 / 配文区，mode=edit 才渲染", async (t) => {
  const ui = await boot(t, LOCKED_ROUTES);
  const { card } = ui.win.__t02;
  const render = (mode) => {
    const box = ui.doc.createElement("div");
    box.innerHTML = card(E1, 0, mode);
    return box;
  };
  const all = (box, sel) => Array.from(box.querySelectorAll(sel));

  const read = render("read");
  assert.deepEqual(all(read, ".x"), [], "read 态渲染了撤回角标");
  assert.deepEqual(all(read, ".ops"), [], "read 态渲染了操作行");
  assert.deepEqual(all(read, ".cap"), [], "read 态渲染了配文区");
  assert.deepEqual(all(read, "[data-del]"), [], "read 态渲染了撤回入口");
  assert.deepEqual(all(read, "[data-edit]"), [], "read 态渲染了改写入口");
  assert.ok(read.textContent.includes("已 送 达"), "read 态的封条应是「已送达」");

  // 反向断言：edit 态确实产出这三样。否则上面那组空集合可能只是「渲染器什么都不产出」。
  const edit = render("edit");
  assert.equal(all(edit, ".ops").length, 1, "edit 态应有操作行");
  assert.equal(all(edit, "[data-del]").length, 1, "edit 态应有撤回入口");
  assert.ok(edit.textContent.includes("封 存 中"), "edit 态的封条应是「封存中」");
  assert.equal(all(read, "textarea").length, 0, "read 态不该有输入框");
});

test("布置台是真的能用：写一句 / 改一下 / 撤回都打到接口上", async (t) => {
  const posted = { id: "e2", kind: "text", body: "谢谢你那天没有走开。", ord: 2, created: 1759000000001, photo: null };
  const ui = await boot(t, {
    "GET /api/status": LOCKED_STATUS,
    "GET /api/me": { status: 200, body: ME },
    "GET /api/entry": { status: 200, body: { mine: MINE, theirs: [FAKE_THEIRS] } },
    "POST /api/entry": { status: 201, body: { entry: posted } },
    "PATCH /api/entry/e1": { status: 200, body: { entry: { ...E1, body: "改过一次的留言" } } },
    "DELETE /api/entry/e2": { status: 204 },
    "POST /api/logout": { status: 204 },
  });
  ui.click('[data-go="desk"]');

  ui.click('[data-add="text"]');
  ui.fill("#new-body", posted.body);
  ui.submit('form[data-form="new"]');
  await until(() => ui.text().includes(posted.body), "写入的留言没有出现在墙上");
  assert.ok(ui.seen.includes("POST /api/entry"), "没有真的打 POST /api/entry");

  ui.click('[data-edit="e1"]');
  ui.fill('form[data-form="edit"] [data-body]', "改过一次的留言");
  ui.submit('form[data-form="edit"]');
  await until(() => ui.text().includes("改过一次的留言"), "改写后的正文没有出现在墙上");
  assert.ok(ui.seen.includes("PATCH /api/entry/e1"), "没有真的打 PATCH /api/entry/:id");

  ui.click('[data-del="e2"]');
  await until(() => !ui.text().includes(posted.body), "撤回后留言还在墙上");
  assert.ok(ui.seen.includes("DELETE /api/entry/e2"), "没有真的打 DELETE /api/entry/:id");

  assertNoLeak(ui.text(), "布置台（写改撤之后）", t);

  ui.click("[data-logout]");
  await until(() => ui.text().includes("我先去布置"), "退出后应当回到封印页，且没有会话");
  assert.ok(ui.seen.includes("POST /api/logout"), "没有真的打 POST /api/logout");
});

test("开门时刻硬编码为东八区 2026-10-05T00:00:00", async (t) => {
  const ui = await boot(t, LOCKED_ROUTES);
  const at = ui.win.__t02.UNLOCK_AT;
  assert.equal(at, Date.UTC(2026, 9, 5, 0, 0, 0) - 8 * 3600 * 1000, "开门时刻不是东八区那一个瞬时");

  // 换个时区的机器上也必须是同一刻：只读 getUTC*，与运行机器的时区无关
  const d = new Date(at + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  assert.equal(
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
    "2026-10-05 00:00:00"
  );
});

test("没有 CDN、没有外部字体：资源只有本目录的三个文件", () => {
  const html = fs.readFileSync(HTML_FILE, "utf8");
  const css = fs.readFileSync(CSS_FILE, "utf8");
  assert.ok(html.includes('src="app.js"'), "index.html 没有引 app.js");
  assert.ok(html.includes('href="style.css"'), "index.html 没有引 style.css");
  for (const [name, src] of [["index.html", html], ["style.css", css]]) {
    assert.ok(!/https?:\/\//.test(src), `${name} 引了外部地址`);
    assert.ok(!/(src|href)\s*=\s*["']\/\//.test(src), `${name} 里有协议相对地址`);
  }
  assert.ok(!/@import|url\(/.test(css), "style.css 里有外部资源引用，字体应当零下载");
  assert.ok(css.includes("Songti SC") && css.includes("serif"), "正文应当是系统衬线");
});

/* ====================================================================== *
 * 密码页说的是**对方**的生日，不是你自己的
 *
 * 真机调试时发现的：选「【改这里：doorCode】」后那一屏写的是「说出 【改这里：girlfriend】 的生日」——
 * 那正是登录者自己的生日。SPEC §一写的是【改这里：doorCode】用**【改这里：heroCode】**（【改这里：boyfriend】）的生日进门，
 * 照着屏幕输会进不去。同一屏的 aria-label 和失败提示都写着「对方的生日」，
 * 三处自相矛盾，而 127 条测试没有一条碰过这句文案。
 * ====================================================================== */

/** SPEC §一：【改这里：doorCode】用【改这里：heroCode】（【改这里：boyfriend】）的生日进门，【改这里：heroCode】用【改这里：doorCode】（【改这里：girlfriend】）的生日进门 */
const PAIR = {
  door: { code: "【改这里：doorCode】", other: "【改这里：boyfriend】" },
  hero: { code: "【改这里：heroCode】", other: "【改这里：girlfriend】" },
};

/** 没有会话（/api/me → 401）才会停在封印页，这正是线上首次访问的样子 */
const NO_SESSION_ROUTES = {
  "GET /api/status": LOCKED_STATUS,
  "GET /api/me": { status: 401, body: { error: "no_session" } },
};

for (const [me, want] of Object.entries(PAIR)) {
  test(`密码页（${want.code}）说的是${want.other}的生日，不是自己的`, async (t) => {
    const ui = await boot(t, NO_SESSION_ROUTES);
    assert.ok(ui.text().includes("我先去布置"), "封印页没出来");
    ui.click('[data-go="who"]');                            // 我先去布置 →
    await until(() => ui.text().includes("你是谁"), "身份页没出来");
    ui.click(`[data-who="${me}"]`);
    await until(() => !!ui.doc.querySelector("#pin"), "密码页没出来");

    const hint = ui.doc.querySelector(".hint").textContent;
    assert.ok(
      hint.includes(`说出 ${want.other} 的生日`),
      `密码页应当让登录者说出${want.other}的生日，实际是：${hint}`,
    );
    // 反向断言：自己的角色一个字都不许出现在这一屏。
    // 这一条才是真正承重的——只断言「出现了对方的角色」的话，
    // 一句「说出 【改这里：girlfriend】 和 【改这里：boyfriend】 的生日」也能蒙混过关。
    const mine = me === "door" ? "【改这里：girlfriend】" : "【改这里：boyfriend】";
    assert.ok(
      !hint.includes(mine),
      `密码页说出了登录者**自己**的角色「${mine}」，照着输会进不去：${hint}`,
    );
  });
}
/* ====================================================================== *
 * 形象映射：白熊 = 【改这里：doorCode】，褐熊 = 【改这里：heroCode】
 *
 * 2026-10-02 用户定死的（design.md §3.1.1）。之前三处一致地挂反了：
 * 身份卡、密码页、合照组。白挂到了【改这里：heroCode】名下，褐挂到了【改这里：doorCode】名下。
 *
 * 这条测试直接从 public/app.js 的源码里读出映射，而不是写死期望值——
 * 写死期望值的话，源码一改就会变成「断言旧值」，给出错误的安全感。
 * 但也不能整段贴进去当恒真断言，所以逐条点名：door 那一行必须含白熊的文件名、
 * 绝不含褐熊的，hero 反之。把两个方向都点名了，「对调」这种失效就抓得住。
 * ====================================================================== */

test("形象映射：白熊 = 【改这里：doorCode】，褐熊 = 【改这里：heroCode】（design.md §3.1.1）", () => {
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const block = src.match(/const WHO_IMG = \{[\s\S]*?\};/);
  assert.ok(block, "public/app.js 里找不到 WHO_IMG —— 形象映射不该散落成一堆 tl/tr 位置名");

  const map = Object.fromEntries(
    [...block[0].matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  // 白熊 bb07 → 【改这里：doorCode】；褐熊 bb08 → 【改这里：heroCode】。两条都点名，方向反了立刻红。
  assert.equal(map.door, "yier-bubu/bb07.jpg", "【改这里：doorCode】（【改这里：girlfriend】）应当是白熊 bb07");
  assert.equal(map.hero, "yier-bubu/bb08.jpg", "【改这里：heroCode】（【改这里：boyfriend】）应当是褐熊 bb08");
  assert.notEqual(map.door, map.hero, "两个身份用的是同一张图，等于没有映射");

  // 合照组：左 = 【改这里：doorCode】（白 bb02）· 右 = 【改这里：heroCode】（褐 bb03）
  assert.match(src, /duoL:\s*"yier-bubu\/bb02\.jpg"/, "合照组左侧应当是白熊 bb02（【改这里：doorCode】）");
  assert.match(src, /duoR:\s*"yier-bubu\/bb03\.jpg"/, "合照组右侧应当是褐熊 bb03（【改这里：heroCode】）");

  // 身份页与布置台装饰必须直接用 WHO_IMG，不能再有 tl/tr 之类位置名——
  // 位置名就是下一次被「顺手对调」的入口。
  assert.ok(src.includes('cardOf("door", WHO_IMG.door)'), "身份卡上【改这里：doorCode】没有用 WHO_IMG.door");
  assert.ok(src.includes('cardOf("hero", WHO_IMG.hero)'), "身份卡上【改这里：heroCode】没有用 WHO_IMG.hero");
  assert.ok(!/IMG\.tl|IMG\.tr|IMG\.big/.test(src), "还有地方在用位置名 tl/tr/big 取形象——那是会被对调的地方");
});

test("密码页头像 = 身份卡上那一只（不许另挑一张）", () => {
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  assert.ok(
    /bub\(WHO_IMG\[S\.me\]/.test(src),
    "密码页头像没有用 WHO_IMG[S.me]——刚点的角色和下一屏的角色之间会插入一次脑内对调",
  );
});

/* ══════════ 浏览器不许替她记住生日（CONSTRAINTS §3）══════════
   断言落在**渲染出来的那个 input 上**，不是源码里那句字符串：
   源码扫描会被注释骗过（「代码里写着 off，注释里也写着 off」），
   而这里量的是浏览器真正拿到的那一个元素。 */

/** 找出源码里所有带 autocomplete 的属性取值。用来断言「全站没有第二个凭据字段」。
 *  引号与大小写都放进去：只认双引号的话，后人把写法换成单引号，这条断言就瞎了
 *  ——「没抓到」会被读成「没有」，而其实是有。 */
function autocompleteValues(src) {
  return [...src.matchAll(/autocomplete\s*=\s*["']?([^"'\s>]+)["']?/gi)].map((m) => m[1]);
}

test("生日输入框：浏览器密码管理器拿不到它", async (t) => {
  // 匿名进入 = 冷启动那条路。已登录时封印页的入口直接是「进 去 看」，
  // 走不到密码页，所以「每次都要重新选身份验证」这句话验的正是这条缝。
  const ui = await boot(t, {
    "GET /api/status": LOCKED_STATUS,
    "GET /api/me": { status: 401, body: { error: "no_session" } },
  });
  assert.equal(
    ui.doc.querySelector('[data-go="who"]') === null,
    false,
    "匿名进来该看到「我先去布置」入口 —— 下面那几行点不到身份页",
  );
  ui.click('[data-go="who"]');
  await until(() => !!ui.doc.querySelector(".idcard"), "身份页没出来");
  ui.click('[data-who="door"]');
  await until(() => !!ui.doc.querySelector("#pin"), "密码页没出来");

  const pin = ui.doc.querySelector("#pin");
  assert.ok(pin, "没渲染出 #pin——下面这些断言会全部空转");
  t.diagnostic(`#pin type=${pin.getAttribute("type")} autocomplete=${pin.getAttribute("autocomplete")}`);

  // 1. 规范里唯一明说「这不是凭据字段」的值。**不是 "off"** ——
  //    Chrome / Safari 在登录场景下不认 off，照样弹保存、照样回填。
  assert.equal(
    pin.getAttribute("autocomplete"),
    "one-time-code",
    "生日框的 autocomplete 不是 one-time-code——浏览器可能替她记住生日，「每次验证身份」就没了",
  );
  assert.notEqual(
    pin.getAttribute("autocomplete"),
    "off",
    'autocomplete="off" 看着像护栏，实际不承重：Chrome / Safari 会忽略它',
  );

  // 2. 没有 name：密码管理器凑不出「用户名 + 密码」这一对，就不会提议保存
  assert.equal(pin.getAttribute("name"), null, "生日框有了 name —— 密码管理器会拿它当用户名字段");

  // 3. 不在 <form> 里：提交与回填都无入口（整站都不该有包着它的 form）
  assert.equal(pin.closest("form"), null, "生日框被 <form> 包住了 —— 浏览器可以自动提交/回填");

  // 4. type 不是 password：数字键盘还在，但不进密码库
  assert.notEqual(pin.getAttribute("type"), "password", "生日框用了 type=password");

  // 界面上的正确性不能被源码里的「正确写法」顶替：整个 app.js 都不许再有第二个凭据字段
  const src = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const values = autocompleteValues(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, ""));
  assert.equal(values.length, 1, `app.js 里出现了 ${values.length} 个 autocomplete 字段：${JSON.stringify(values)}`);
  assert.deepEqual(values, ["one-time-code"], "app.js 里出现了第二个 autocomplete 字段");

  // 探测器自证：先证明它**抓得到**，再拿它说「没抓到」。否则这条是恒真式。
  // 单引号、无引号、大小写混写都要能抓到——少一种，「没抓到」就不再等于「没有」。
  assert.deepEqual(
    autocompleteValues(`<input autocomplete="off"><input autocomplete='new-password'>`),
    ["off", "new-password"],
    "autocompleteValues 抓不到双引号 / 单引号写法 —— 上面那条「全站没有第二个字段」没有鉴别力",
  );
  assert.deepEqual(
    autocompleteValues(`<input autocomplete=current-password><input AutoComplete="cc-number">`),
    ["current-password", "cc-number"],
    "autocompleteValues 抓不到无引号 / 混合大小写写法 —— 同上",
  );
});

test("bfcache 回来时生日被抠掉：浏览器自己的表单恢复也堵住", async (t) => {
  // 上面四条管的是**密码管理器**，管不到浏览器**自己的表单状态恢复**：
  // 她输了生日 → 按后退离开 → 又按前进回来，整张表单被 bfcache 原样恢复，值还在。
  // 成因完全不同，所以前四条一条都拦不住 —— 这条单独验它。
  const ui = await boot(t, {
    "GET /api/status": LOCKED_STATUS,
    "GET /api/me": { status: 401, body: { error: "no_session" } },
  });
  ui.click('[data-go="who"]');
  await until(() => !!ui.doc.querySelector(".idcard"), "身份页没出来");
  ui.click('[data-who="door"]');
  await until(() => !!ui.doc.querySelector("#pin"), "密码页没出来");

  // 纯 jsdom，不打服务端：要的是「口令真填进去了」，值本身取【改这里：doorCode】的测试口令。
  const pin = ui.fill("#pin", "00010101");
  assert.equal(pin.value, "00010101", "填不进去 —— 下面那条 bfcache 断言就是空转");

  // 从 bfcache 回来：persisted=true。jsdom 不实现 bfcache 本身，
  // 但 pageshow 事件就是浏览器回来的那一刻发的——这里验的是「收到就清空」这条逻辑。
  const ev = new ui.win.Event("pageshow");
  Object.defineProperty(ev, "persisted", { value: true });
  ui.win.dispatchEvent(ev);

  assert.equal(
    ui.doc.querySelector("#pin").value,
    "",
    "从 bfcache 回来后生日还在输入框里 —— 点一下就进去了，「每次都要验证」漏在这里",
  );
  t.diagnostic("pageshow(persisted=true) 后 #pin.value 已清空");
});

test("被锁定时密码页说的是「等 N 秒」，不是「你输错了」", async (t) => {
  // submitPin() 不走 fail()，429 的响应体里又没有 hint ——
  // 少了那一行分支，被锁 10 分钟的人看到的是「不对。试试对方的生日。」，
  // 会以为自己又输错了，然后接着试。
  const ui = await boot(t, {
    "GET /api/status": LOCKED_STATUS,
    "GET /api/me": { status: 401, body: { error: "no_session" } },
    "POST /api/login": { status: 429, body: { error: "locked", retryAfter: 600 } },
  });
  ui.click('[data-go="who"]');
  await until(() => !!ui.doc.querySelector(".idcard"), "身份页没出来");
  ui.click('[data-who="door"]');
  await until(() => !!ui.doc.querySelector("#pin"), "密码页没出来");

  ui.fill("#pin", "1111");
  ui.click('[data-go="desk"]');
  await until(() => ui.text().includes("试太多次了"), "429 没有显示「试太多次了」");

  const msg = ui.doc.querySelector("#pmsg").textContent;
  assert.match(msg, /试太多次了，\s*600\s*秒后再来。/, `429 的提示不对：${msg}`);
  assert.ok(
    !msg.includes("不对。试试对方的生日。"),
    "被锁时还在说「不对」——她会以为自己输错了，接着试",
  );
  t.diagnostic(`429 提示：${msg}`);
});

test("会话 cookie 不落盘：没有正的 Max-Age / Expires", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "auth.js"), "utf8");
  // 扫**所有**写 Set-Cookie 的行，不只第一条：clearSessionCookie 也写，
  // 今天它带 Max-Age=0（这是删除的正确写法），将来有人给它加落盘属性也得看得见。
  const lines = src.split("\n").filter((l) => l.includes("Set-Cookie"));
  assert.ok(lines.length >= 2, `src/auth.js 里只找到 ${lines.length} 行写 Set-Cookie —— 扫描范围不对`);

  // 探针自证：先把探针喂一个「真正落盘」的 cookie，它必须报出来
  const isDurable = (s) => {
    const maxAge = /;\s*max-age\s*=\s*(\d+)/i.exec(s);
    if (maxAge && Number(maxAge[1]) > 0) return true;     // Max-Age=0 是删除，不是落盘
    return /;\s*expires\s*=/i.test(s);
  };
  assert.ok(isDurable("a=b; Max-Age=86400; Path=/"), "探针抓不到正的 Max-Age —— 下面那条是恒真式");
  assert.ok(isDurable("a=b; Expires=Wed, 05 Oct 2026; Path=/"), "探针抓不到 Expires —— 同上");
  assert.ok(!isDurable("a=b; Max-Age=0; Path=/"), "探针把 Max-Age=0（删除）误判成落盘 —— 下面会假红");

  for (const l of lines) {
    assert.ok(!isDurable(l), `会话 cookie 这行带了落盘属性，它会变成一份留在盘上的凭据（CONSTRAINTS §3）：${l.trim()}`);
  }
});
