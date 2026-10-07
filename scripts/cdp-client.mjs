/**
 * 工单 06 浏览器取证 · 极小的 CDP 客户端。
 *
 * 为什么自己写：机器上没有可用的 chrome-devtools MCP 工具，而这次要验的
 * 恰恰是 jsdom 验不了的东西（真实排版引擎、真实图片解码、真实命中区域）。
 * Node 22+ 自带 WebSocket 与 fetch，所以驱动真 Chrome 不需要装任何依赖。
 *
 * 只做四件事：起进程、连浏览器、开页面、跑表达式。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/** 找 Chrome。Windows 上按常见安装位置找；找不到就如实说。 */
export function findChrome() {
  const cands = [
    process.env.CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  throw new Error("本机没找到 Chrome/Edge：设 CHROME=<可执行文件路径> 再跑");
}

export async function launch({ userDataDir, windowSize = "390,844" }) {
  const bin = findChrome();
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--hide-crash-restore-bubble",
    "--disable-background-networking",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (b) => (log += b));
  proc.stderr.on("data", (b) => (log += b));

  // Chrome 把实际端口写进 DevToolsActivePort（第一行端口、第二行 ws 路径）
  //
  // ⚠️ 复用同一个 userDataDir 之前**必须先删掉这个文件**：它属于上一次那个浏览器。
  // 不删的话，启动循环第一次就读到上次的 ws 路径，Page.attach 于是连一个已经不存在的
  // 浏览器 —— 报出来是「连不上 ws://…/devtools/browser/…」，看着像页面挂了，
  // 实际上新浏览器连起来都没试过。表现是「同一个角色跑两段，第二段必红」。
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  try { fs.unlinkSync(portFile); } catch {}
  let wsPath = null;
  for (let i = 0; i < 200 && !wsPath; i++) {
    await sleep(100);
    try {
      const [port, p] = fs.readFileSync(portFile, "utf8").split("\n");
      if (port && p) wsPath = `ws://127.0.0.1:${port.trim()}${p.trim()}`;
    } catch {}
  }
  if (!wsPath) {
    proc.kill("SIGKILL");
    throw new Error(`Chrome 起了但没写 DevToolsActivePort：\n${log.slice(-500)}`);
  }
  return { proc, wsPath, bin };
}

/** 一个页面会话：附着到新 target，页面域的命令都带 sessionId。 */
export class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (${JSON.stringify(m.error.data ?? "")})`)) : resolve(m.result);
        return;
      }
      const key = `${m.sessionId || ""}:${m.method}`;
      for (const w of this.events.get(key) || []) w(m.params);
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`连不上 ${wsUrl}`)), { once: true });
    });
    const p = new Page(ws);
    const { targetId } = await p.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await p.send("Target.attachToTarget", { targetId, flatten: true });
    p.sessionId = sessionId;
    await p.send("Page.enable");
    await p.send("Runtime.enable");
    // 页面里抛的异常直接打出来：不然只能看到"#app 是空的"这种结果，看不到原因
    p.on("Runtime.exceptionThrown", (params) => {
      const d = params.exceptionDetails;
      console.error("  [页面异常]", d.exception?.description || d.text, d.url ? `@${d.url}:${d.lineNumber}` : "");
    });
    p.on("Runtime.consoleAPICalled", (params) => {
      if (params.type === "error" || params.type === "warning") {
        console.error(`  [页面${params.type}]`, params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
      }
    });
    return p;
  }

  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (useSession && this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 60_000);
    });
  }

  on(method, fn) {
    const key = `${this.sessionId}:${method}`;
    this.events.set(key, [...(this.events.get(key) || []), fn]);
  }

  once(method, timeout = 20_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等不到事件：${method}`)), timeout);
      this.on(method, (params) => { clearTimeout(timer); resolve(params); });
    });
  }

  /** 视口：mobile=true 才会按 <meta viewport> 处理（390×844 手机 / 1280×900 桌面） */
  async viewport({ width, height, mobile, dsf = 2 }) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: dsf, mobile,
      screenWidth: width, screenHeight: height,
    });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: !!mobile, maxTouchPoints: mobile ? 5 : 1 });
  }

  async goto(url) {
    const loaded = this.once("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /**
   * 等一个页面里的条件成立。
   *
   * 踩过的坑：window.__t06 是脚本**同步**挂上去的，而 #app 的内容要等 boot() 里
   * 那一串 fetch 回来才画出来。goto() 返回 ≠ 界面画好了 —— 量早了会得到
   * 「#app 是空的」这种假结论。所有"进页面/进下一屏"之后都必须等它。
   */
  async waitFor(expression, { timeout = 20_000, every = 100, label = expression } = {}) {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await this.eval(`!!(${expression})`, { awaitPromise: false }); } catch {}
      if (v) return true;
      if (Date.now() - t0 > timeout) throw new Error(`等不到页面里的条件（${timeout}ms）：${label}`);
      await sleep(every);
    }
  }

  /** 跑一段页面里的表达式（async 会被 await） */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面里报错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async shot(file, { full = true } = {}) {
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full, optimizeForSpeed: false });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    return file;
  }

  /** 给 <input type=file> 塞真文件（走 DOM.setFileInputFiles，随后会派发 change） */
  async setFileInput(selector, filePath) {
    const { root } = await this.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await this.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`找不到 ${selector}`);
    await this.send("DOM.setFileInputFiles", { files: [filePath], nodeId });
  }

  close() { try { this.ws.close(); } catch {} }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
