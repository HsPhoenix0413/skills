#!/usr/bin/env node
/**
 * imgfetch — 从多级跳转、环境门槛型落地页中提取深藏的图片资源
 *
 * 用法:
 *   node imgfetch.js <url> [--out DIR] [--click TEXT] [--wait SEC]
 *                    [--content-only|--all] [--no-download] [--desktop] [--keep-temp]
 *
 * 阶段: 探测 → 追跳转链(静态) → jsdom手机QQ模拟运行 → 下载+魔数验证
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL_DIR = __dirname;
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/9.0.0.620 V1_IPH_SQ_9.0.0 MQQBrowser/9.0.0';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// 装饰性静态资源域名：出现在页面骨架里的，不算正文图
const DECO_HOSTS = /(zstatic\.net|npmmirror\.com|open\.mobile\.qq\.com|gtimg\.cn|qq\.com\/sdk|jquery|hdslb\.com|autoimg\.cn|bcebos\.com|artplayer\.org|w3\.org|schema\.org)/i;

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = {
    url: null, out: null, click: null, wait: 60,
    contentOnly: true, download: true, ua: 'mobile', keepTemp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--click') opts.click = argv[++i];
    else if (a === '--wait') opts.wait = parseInt(argv[++i], 10) || 60;
    else if (a === '--all') opts.contentOnly = false;
    else if (a === '--content-only') opts.contentOnly = true;
    else if (a === '--no-download') opts.download = false;
    else if (a === '--desktop') opts.ua = 'desktop';
    else if (a === '--keep-temp') opts.keepTemp = true;
    else if (!a.startsWith('--') && !opts.url) opts.url = a;
    else { console.error('未知参数: ' + a); process.exit(2); }
  }
  if (!opts.url) {
    console.error('用法: node imgfetch.js <url> [--out DIR] [--click TEXT] [--wait SEC] [--all] [--no-download] [--desktop] [--keep-temp]');
    process.exit(2);
  }
  return opts;
}
const opts = require.main === module
  ? parseArgs(process.argv.slice(2))
  : { url: null, out: null, click: null, wait: 60, contentOnly: true, download: true, ua: 'mobile', keepTemp: false };
const UA = opts.ua === 'desktop' ? DESKTOP_UA : MOBILE_UA;
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'imgfetch-'));
const log = (...m) => console.log('[imgfetch]', ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面里的第三方脚本（如字体加载器）抛异常不应终止整个提取流程
if (require.main === module) {
  process.on('uncaughtException', (e) => log('忽略未捕获异常:', String(e && e.message || e).slice(0, 150)));
  process.on('unhandledRejection', (e) => log('忽略未处理的 Promise 拒绝:', String(e && e.message || e).slice(0, 150)));
}

// ---------- 依赖 ----------
const SKILL_ROOT = path.dirname(SKILL_DIR); // 依赖装在 skill 根目录
function ensureDeps() {
  const need = ['jsdom'];
  for (const m of need) {
    try { require.resolve(m, { paths: [SKILL_ROOT, process.cwd()] }); }
    catch {
      log('首次运行，安装依赖 (jsdom, canvas)...');
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(npmCmd, ['i', '--prefix', SKILL_ROOT, '--no-audit', '--no-fund', 'jsdom', 'canvas'], { stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) { console.error('依赖安装失败，请手动执行: npm i --prefix ' + SKILL_ROOT + ' jsdom canvas'); process.exit(1); }
    }
  }
  return require(require.resolve('jsdom', { paths: [SKILL_ROOT, process.cwd()] }));
}

// ---------- 阶段1: 探测 ----------
async function fetchPage(url, ua) {
  const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept': 'text/html,image/*,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  return { url: res.url, status: res.status, ct, buf, isHtml: /text\/html/i.test(ct) };
}

// ---------- 阶段2: 追跳转链 ----------
function extractCandidates(html, baseUrl) {
  const found = new Set();
  const base = new URL(baseUrl);
  const search = base.search; // 页面自己拼 URL 时会带上 location.search（含 s= 签名），必须保留
  const add = (u, keepSearch) => {
    try {
      const a = new URL(u, baseUrl);
      if (!/^https?:/.test(a.href)) return;
      // 资源型路径且候选 URL 没带查询参数 → 补上当前页的签名参数
      if (keepSearch && search && !a.search && /[0-9a-f]{8}-[0-9a-f-]{20,}/.test(a.pathname)) a.search = search;
      found.add(a.href);
    } catch {}
  };
  // 内联脚本中的绝对 URL（排除常见静态库域名）
  const abs = html.match(/https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]{10,300}/g) || [];
  for (const u of abs) if (!DECO_HOSTS.test(u) && !/\.(js|css|m3u8|ts|mp4)(\?|$)/i.test(u)) add(u, true);
  // iframe src（绝对或相对）
  const iframes = html.match(/<iframe[^>]*>/gi) || [];
  for (const tag of iframes) {
    const m = tag.match(/src="([^"]+)"/i);
    if (m && !/^https?:/.test(m[1]) && !m[1].startsWith('data:')) add(m[1], true);
  }
  // 形如 "相对资源路径变量" 的字符串（uuid 型资源名，_0 结尾），页面实际会拼上 location.search
  const relVars = html.match(/"([a-z0-9_]{6,}_[0-9a-f]{8}-[0-9a-f-]{27,36}_\d)"/gi) || [];
  for (const v of relVars) add(v.slice(1, -1), true);
  return [...found];
}

async function followChain(startUrl, ua) {
  const chain = [{ url: startUrl }];
  const seen = new Set([startUrl]);
  let current = await fetchPage(startUrl, ua);
  current.html = current.isHtml ? current.buf.toString('utf8') : null;
  let hop = 0;
  while (current.isHtml && hop < 3) {
    fs.writeFileSync(path.join(TMP, `hop${hop}.html`), current.html);
    // 壳页才需要追跳转（1-4KB）；已经是完整落地页（>8KB）就停，避免把 API 域名/无关站点当成下一跳
    if (current.buf.length > 8192) break;
    const candidates = extractCandidates(current.html, current.url);
    let next = null;
    for (const c of candidates) {
      if (seen.has(c)) continue;
      seen.add(c);
      // 纯域名根路径（API_BASE 之类）不是跳转目标
      try { if (new URL(c).pathname === '/') continue; } catch { continue; }
      let page;
      try { page = await fetchPage(c, ua); } catch { continue; }
      page.html = page.isHtml ? page.buf.toString('utf8') : null;
      if (page.isHtml && page.html.length > 500) {
        // 找到了下一跳：优先带同族资源特征的页面
        next = { url: page.url, page };
        break;
      }
    }
    if (!next) break;
    chain.push({ url: next.url });
    current = next.page;
    hop++;
  }
  if (!current.isHtml) return { chain, final: current, finalHtml: null };
  fs.writeFileSync(path.join(TMP, `hop${hop}.html`), current.html);
  return { chain, final: current, finalHtml: current.html };
}

// ---------- 阶段3: jsdom 手机模拟 ----------
async function simulate(finalUrl, ua) {
  const { JSDOM, VirtualConsole } = ensureDeps();
  const eventLog = [];
  const mediaUrls = new Set();   // m3u8/mp4 等其他媒体（附赠记录）
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => eventLog.push('JSDOM_ERR ' + String(e.message || e).slice(0, 200)));

  const dom = await JSDOM.fromURL(finalUrl, {
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    userAgent: ua,
    beforeParse(window) {
      // jsdom 缺失的常见 API 桩，缺了页面脚本会提前崩
      window.matchMedia = (q) => ({ matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } });
      class StubObserver { observe() {} unobserve() {} disconnect() {} }
      window.IntersectionObserver = window.IntersectionObserver || StubObserver;
      window.ResizeObserver = window.ResizeObserver || StubObserver;
      window.scrollTo = window.scrollTo || (() => {});
      // QQ 桥接桩：页面用 mqq.invoke 判定环境
      window.mqq = {
        ios: ua.includes('iPhone'), android: ua.includes('Android'), version: '9.0.0.620',
        invoke: (ns, act, o, cb) => { eventLog.push('MQQ ' + ns + '/' + act); try { cb && cb({ ret: 0 }); } catch {} },
        on: () => {}, off: () => {},
      };
      // 关键：jsdom 没有 window.fetch，必须用 Node 原生 fetch 兜底并截获
      const realFetch = global.fetch;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        eventLog.push('FETCH ' + ((init && init.method) || 'GET') + ' ' + url.slice(0, 200));
        if (/\.(m3u8|mp4)(\?|$)/i.test(url) || /m3u8/i.test(url)) mediaUrls.add(url);
        return realFetch(input, init);
      };
      const XHRP = window.XMLHttpRequest.prototype;
      const oOpen = XHRP.open, oSend = XHRP.send;
      XHRP.open = function (m, u) { this.__u = u; return oOpen.call(this, m, u); };
      XHRP.send = function () {
        this.addEventListener('load', () => {
          try { eventLog.push('XHR ' + this.status + ' ' + String(this.__u).slice(0, 200)); } catch {}
        });
        return oSend.apply(this, arguments);
      };
      window.sendBeacon = (u) => { eventLog.push('BEACON ' + String(u).slice(0, 200)); return true; };
      window.addEventListener('error', (e) => eventLog.push('WIN_ERR ' + (e.message || '')));
    },
  });
  const w = dom.window, doc = w.document;

  // MutationObserver 抓动态注入的 img/video/source/背景图
  const dynamic = new Set();
  const mo = new w.MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      const grab = (el) => {
        if (el.tagName === 'IMG' && el.src) dynamic.add(el.src);
        if (el.tagName === 'SOURCE' && el.src) dynamic.add(el.src);
        if (el.tagName === 'VIDEO') {
          if (el.src) mediaUrls.add(el.src);
          if (el.querySelectorAll) el.querySelectorAll('source').forEach((s) => s.src && mediaUrls.add(s.src));
        }
        const st = el.getAttribute && el.getAttribute('style');
        if (st) { const mm = st.match(/url\(([^)]+)\)/); if (mm) dynamic.add(mm[1].replace(/['"]/g, '')); }
        if (el.querySelectorAll) el.querySelectorAll('img[src],source[src]').forEach(grab);
      };
      grab(n);
    }
  });
  mo.observe(doc.documentElement, { childList: true, subtree: true });

  // 等页面初始加载
  await sleep(12000);

  // 找并点击解锁/确认按钮
  let clicked = null;
  for (let t = 0; t < 4 && !clicked; t++) {
    const btns = [...doc.querySelectorAll('button, [role=button], a.btn, .btn')];
    const target = btns.find((b) => {
      const txt = (b.textContent || '').trim();
      if (opts.click) return txt.includes(opts.click) || (b.id || '').includes(opts.click);
      // 付费/下单按钮绝不自动点
      if (/支付|¥|付费|购买|下单/.test(txt)) return false;
      return /confirm/i.test(b.id) || /确认|观看|验证|继续|解锁|开始/.test(txt);
    });
    if (target) { target.click(); clicked = target.id || (target.textContent || '').trim().slice(0, 20); break; }
    await sleep(3000);
  }
  log(clicked ? `已点击按钮: ${clicked}` : '未找到可点击按钮，仅观察页面加载结果');

  // 轮询观察
  let stable = 0, lastCount = dynamic.size;
  const total = Math.max(1, Math.round(opts.wait / 5));
  for (let i = 0; i < total; i++) {
    await sleep(5000);
    if (dynamic.size > 0 && dynamic.size === lastCount) { stable++; if (stable >= 3) { log(`图片数量已稳定(${dynamic.size})，提前结束`); break; } }
    else stable = 0;
    lastCount = dynamic.size;
  }
  // 汇总：动态注入 + DOM 中全部 img
  const staticImgs = new Set([...doc.images].map((i) => i.src));
  return { dynamic: [...dynamic], staticImgs: [...staticImgs], mediaUrls: [...mediaUrls], eventLog };
}

// ---------- 阶段4: 下载 + 魔数验证 ----------
const MAGIC = [
  ['gif', 'GIF8'],
  ['png', (b) => b[0] === 0x89 && b[1] === 0x50],
  ['jpg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['webp', (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'],
  ['bmp', (b) => b[0] === 0x42 && b[1] === 0x4d],
  ['svg', (b) => b.slice(0, 200).toString().trimStart().startsWith('<svg')],
];
function sniffType(buf) {
  for (const [ext, test] of MAGIC) if (typeof test === 'string' ? buf.slice(0, 4).toString().startsWith(test) : test(buf)) return ext;
  return null;
}

// ---------- 输出文件夹探测 ----------
// 规则：图片和视频各自独立分放，每次运行必须保存到一个"空"（无任何媒体文件）的文件夹：
//   1. 先遍历已存在的目标文件夹；找到没有任何媒体的 → 直接复用
//   2. 全部都有内容 → 新建顺延编号的文件夹（如 安全确认图片 2、安全确认视频 3）
//   3. 显式 --out 同样受保护：指向已有媒体的文件夹时自动顺延，绝不覆盖
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic)$/i;
const VID_EXT = /\.(ts|m3u8|mp4|webm|mkv|mov|avi)$/i;
const ANY_MEDIA_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|ts|m3u8|mp4|webm|mkv|mov|avi)$/i;
function hasMedia(dir, extRe) {
  try { return fs.readdirSync(dir).some((f) => extRe.test(f)); } catch { return false; }
}
function hasImages(dir) { return hasMedia(dir, IMG_EXT); }
function resolveOutDir(explicit, kind = '图片') {
  const base = process.cwd();
  const DEFAULT_BASENAME = '安全确认' + kind;
  const extRe = kind === '视频' ? VID_EXT : IMG_EXT;
  if (explicit) {
    if (!fs.existsSync(explicit) || !hasMedia(explicit, ANY_MEDIA_EXT)) return explicit;
    let i = 2;
    while (fs.existsSync(explicit + ' ' + i) && hasMedia(explicit + ' ' + i, ANY_MEDIA_EXT)) i++;
    return explicit + ' ' + i;
  }
  const pattern = new RegExp('^' + DEFAULT_BASENAME + '(?: (\\d+))?$');
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && pattern.test(e.name)); } catch {}
  if (dirs.length === 0) return path.join(base, DEFAULT_BASENAME);
  const empty = dirs.find((d) => !hasMedia(path.join(base, d.name), extRe));
  if (empty) return path.join(base, empty.name);
  let max = 1;
  for (const d of dirs) max = Math.max(max, parseInt(d.name.match(pattern)[1] || '1', 10));
  return path.join(base, DEFAULT_BASENAME + ' ' + (max + 1));
}

async function downloadAll(urls, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = [];
  let idx = 0, ok = 0, fail = 0;
  const worker = async () => {
    while (idx < urls.length) {
      const i = idx++;
      const { url, source } = urls[i];
      const tmpFile = path.join(outDir, `.tmp${i}`);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': MOBILE_UA, 'Referer': new URL(url).origin + '/' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const ct = res.headers.get('content-type') || '';
        const buf = Buffer.from(await res.arrayBuffer());
        // 响应是 HTML（把落地页自己当图片抓了）→ 跳过不保存
        if (/text\/html/i.test(ct)) throw new Error('skip: HTML response, not an image');
        const ext = sniffType(buf) || 'bin';
        const file = String(i + 1).padStart(3, '0') + '.' + ext;
        fs.writeFileSync(path.join(outDir, file), buf);
        manifest.push({ url, file, bytes: buf.length, type: ext, source });
        ok++;
      } catch (e) { fail++; manifest.push({ url, source, error: String(e).slice(0, 120) }); console.error(`  [${i + 1}/${urls.length}] 失败: ${String(e).slice(0, 80)}`); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { ok, fail };
}

// ---------- 主流程 ----------
async function main() {
  log('目标:', opts.url);
  log('临时目录:', TMP, opts.keepTemp ? '(保留)' : '(结束后清理)');

  // 阶段1+2
  const { chain, finalHtml } = await followChain(opts.url, UA);
  log(`跳转链 (${chain.length} 层):`);
  chain.forEach((c, i) => log(`  hop${i}: ${c.url.slice(0, 120)}`));
  if (!finalHtml) { console.error('最终响应不是 HTML，无法继续（可能是直链媒体）。'); process.exit(1); }

  // 阶段3
  const finalUrl = chain[chain.length - 1].url;
  const { dynamic, staticImgs, mediaUrls, eventLog } = await simulate(finalUrl, UA);
  fs.writeFileSync(path.join(TMP, 'events.log'), eventLog.join('\n'));
  log(`动态注入图片: ${dynamic.length}，页面静态图片: ${staticImgs.length}，其他媒体: ${mediaUrls.length}`);

  // 分类：content = 动态注入的；非动态且命中装饰域名的跳过
  const all = new Map();
  for (const u of dynamic) if (/^https?:/.test(u)) all.set(u, 'dynamic');
  for (const u of staticImgs) if (/^https?:/.test(u) && !all.has(u)) all.set(u, 'static');
  let list = [...all].map(([url, source]) => ({ url, source }));
  if (opts.contentOnly) {
    const before = list.length;
    list = list.filter((x) => x.source === 'dynamic' || !DECO_HOSTS.test(new URL(x.url).host));
    log(`content-only: ${before} → ${list.length} 张（排除装饰图 ${before - list.length} 张；--all 可全部保存）`);
  }
  if (list.length === 0) {
    console.error('未发现内容图片。事件日志片段:');
    console.error(eventLog.slice(-30).join('\n'));
    console.error('HTML 快照在: ' + TMP);
    process.exit(3);
  }

  // 阶段4
  const expires = list.find((x) => /[?&](x-expires|Expires)=/.test(x.url));
  if (expires) {
    const m = expires.url.match(/x-expires=(\d+)/);
    if (m) log(`注意: 图片 URL 带签名，过期时间约 ${new Date(parseInt(m[1], 10) * 1000).toLocaleString('zh-CN')}，请尽快使用/备份`);
  }
  if (opts.download) {
    const outDir = resolveOutDir(opts.out);
    log('输出文件夹:', outDir, (fs.existsSync(outDir) ? '(复用空文件夹)' : '(新建)'));
    const { ok, fail } = await downloadAll(list, outDir);
    log(`完成: 成功 ${ok} 张, 失败 ${fail} 张 → ${outDir}`);
    log('清单: ' + path.join(outDir, 'manifest.json'));
    if (mediaUrls.size) log('附: 发现其他媒体 URL ' + mediaUrls.size + ' 个（见 manifest 同级 events.log）: ');
    if (mediaUrls.size) mediaUrls.forEach((u) => log('  ' + u.slice(0, 150)));
  } else {
    log('图片 URL 列表 (' + list.length + '):');
    list.forEach((x, i) => log(`  ${i + 1}. [${x.source}] ${x.url.slice(0, 180)}`));
  }

  if (!opts.keepTemp) fs.rmSync(TMP, { recursive: true, force: true });
  else log('HTML 快照保留在: ' + TMP);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
}
module.exports = { resolveOutDir, hasImages, extractCandidates, sniffType };
