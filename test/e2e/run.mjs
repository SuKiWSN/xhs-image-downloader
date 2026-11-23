#!/usr/bin/env node
// 端到端测试：在真正的 Chrome（或 Edge）里加载插件，打开本地的「假」小红书页面，
// 像用户一样点下载按钮，然后检查硬盘上的文件夹名、文件名和文件内容。
//
//   npm run test:e2e
//
// 可选环境变量：
//   XHSDL_BROWSER=chrome | msedge | chromium   用哪个浏览器（默认本机安装的 Chrome 正式版）
//   CHROME_PATH=/path/to/browser               直接指定浏览器程序
//   HEADFUL=1                                  显示浏览器窗口
//   XHSDL_EXTENSION_DIR=dist                   测试解压后的安装包，而不是仓库里的源码
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { startFakeXhs, NOTES, FILES, noteUrl } from './fake-xhs.mjs';

const require = createRequire(import.meta.url);
const X = require('../../src/shared.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = process.env.XHSDL_EXTENSION_DIR ? path.resolve(process.env.XHSDL_EXTENSION_DIR) : path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(HERE, 'output');
// 按很长的下载目录来测（Windows 用户可能把下载位置设得很深），确认路径不会超过 Windows 的 259 个字符
const DOWNLOAD_DIR_LENGTH = 115;
const WINDOWS_MAX_PATH = 259;
const CRDOWNLOAD = '.crdownload'.length;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const started = Date.now();
const log = (...args) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s]`, ...args);

function findBrowser() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH };
  const name = (process.env.XHSDL_BROWSER || 'chrome').toLowerCase();
  if (name === 'chrome') return { channel: 'chrome' };
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const paths = {
    msedge: {
      win32: [`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`],
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
    },
    chromium: {
      linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
      darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    },
  }[name];
  if (!paths) throw new Error('不认识的 XHSDL_BROWSER：' + name);
  const found = (paths[process.platform] || []).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`没找到 ${name}，可以用 CHROME_PATH 指定浏览器程序的路径`);
  return { executablePath: found };
}

// 在 base 下面一层层建目录，直到路径长度达到 target
function deepDir(base, target) {
  let dir = base;
  while (target - dir.length > 1) dir = path.join(dir, 'd'.repeat(Math.min(target - dir.length - 1, 40)));
  return dir;
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`等待超时：${what}` + (last instanceof Error ? `（${last.message}）` : ''));
}

/* ------------------------------------------------------------------ 准备 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xhsdl-e2e-'));
const profileDir = path.join(root, 'profile');
const downloadDir = deepDir(path.join(root, 'dl'), DOWNLOAD_DIR_LENGTH);
fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloadDir },
  })
);

const server = await startFakeXhs();
const hostRules = [
  `MAP www.xiaohongshu.com 127.0.0.1:${server.port}`,
  `MAP ci.xiaohongshu.com 127.0.0.1:${server.port}`,
  `MAP *.xhscdn.com 127.0.0.1:${server.port}`,
  'MAP * ~NOTFOUND', // 其余网址一律不让访问，保证测试不碰外网
  'EXCLUDE 127.0.0.1',
].join(', ');

const browser = await puppeteer.launch({
  ...findBrowser(),
  headless: !process.env.HEADFUL,
  pipe: true,
  enableExtensions: [EXT_DIR],
  userDataDir: profileDir,
  acceptInsecureCerts: true,
  defaultViewport: { width: 1280, height: 900 },
  timeout: 60000,
  protocolTimeout: 60000,
  args: [
    `--host-resolver-rules=${hostRules}`,
    '--no-proxy-server', // 系统设置了代理时，请求会直接发给代理，上面的映射就不起作用了
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
  ],
});

log('系统：', `${os.type()} ${os.release()} (${process.platform}/${os.arch()})`, '｜浏览器：', await browser.version());
log('下载目录：', downloadDir, `（${downloadDir.length} 个字符）`);

const logs = [];
function watch(page, label) {
  page.on('console', (m) => {
    const text = m.text();
    if (/小红书图片下载|xhsdl/i.test(text) || m.type() === 'error' || m.type() === 'warn') logs.push(`[${label}] ${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => logs.push(`[${label}] pageerror: ${e.message}`));
  return page;
}

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'), { timeout: 30000 });
const extId = new URL(swTarget.url()).host;
log('插件已加载：', extId, '｜来自：', EXT_DIR);

let extPage = null;
async function extensionPage() {
  if (!extPage || extPage.isClosed()) {
    extPage = watch(await browser.newPage(), 'ext');
    await extPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  }
  return extPage;
}
async function setSettings(patch) {
  const p = await extensionPage();
  await p.evaluate((patch) => chrome.storage.sync.set(patch), patch);
}
async function downloadRecords() {
  const p = await extensionPage();
  return p.evaluate(() =>
    chrome.downloads.search({}).then((items) => items.map((i) => ({ state: i.state, error: i.error || '', filename: i.filename, url: i.url, mime: i.mime })))
  );
}

/* ------------------------------------------------------------------ 工具 */
let current = null; // 当前操作的页面，失败时截图

async function openFeed() {
  const page = watch(await browser.newPage(), 'feed');
  await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });
  assert.equal(await page.$eval('meta[name="xhsdl-e2e"]', (m) => m.content), 'fake-xhs', '应该打开的是本地的测试页面');
  return page;
}

async function clickAndWaitToast(page, selector) {
  current = page;
  await page.bringToFront();
  await page.evaluate(() => document.querySelectorAll('.xhsdl-toast').forEach((t) => t.remove()));
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.click(selector);
  return waitFor(
    () =>
      page.evaluate(() => {
        const t = Array.from(document.querySelectorAll('.xhsdl-toast')).find((el) => /--(success|warn|error)\b/.test(el.className));
        if (!t) return null;
        const type = (/--(success|warn|error)\b/.exec(t.className) || [])[1];
        return { type, text: t.querySelector('.xhsdl-toast-text').textContent };
      }),
    45000,
    '下载完成的提示'
  );
}

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// 检查「下载目录/relDir/」里正好是这些文件，内容和服务器返回的一致，且路径长度在 Windows 限制以内
async function expectFolder(relDir, files) {
  const dir = path.join(downloadDir, ...relDir.split('/'));
  const want = Object.keys(files).sort();
  await waitFor(() => {
    const names = listDir(dir);
    return want.every((f) => names.includes(f)) && !names.some((f) => f.endsWith('.crdownload'));
  }, 30000, `文件出现在「${relDir}」`);
  assert.deepEqual(listDir(dir), want, `「${relDir}」里的文件`);
  for (const [name, key] of Object.entries(files)) {
    const full = path.join(dir, name);
    assert.equal(sha(fs.readFileSync(full)), sha(FILES[key]), `${name} 的内容应该是 ${key}`);
    assert(full.length + CRDOWNLOAD <= WINDOWS_MAX_PATH, `路径太长（${full.length} 个字符）：${full}`);
  }
  return dir;
}

const results = [];
async function scenario(name, fn) {
  log('▶', name);
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    log(`  ✓ 通过（${((Date.now() - t) / 1000).toFixed(1)}s）`);
  } catch (e) {
    results.push({ name, ok: false });
    log('  ✗ 失败：', (e && e.stack) || e);
    try {
      const shot = path.join(OUT_DIR, `failure-${results.length}.png`);
      if (current && !current.isClosed()) await current.screenshot({ path: shot, fullPage: true });
      log('    截图：', shot);
      log('    下载记录：', JSON.stringify(await downloadRecords(), null, 2));
      log('    下载目录：', JSON.stringify(walk(downloadDir)));
    } catch (err) {
      log('    （记录现场失败：', err.message, '）');
    }
  }
}

function walk(dir, prefix = '') {
  const out = [];
  for (const name of listDir(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p, prefix + name + '/'));
    else out.push(prefix + name);
  }
  return out;
}

const cardButton = (entry) => `.xhsdl-btn--card[data-note-id="${entry.id}"]`;
const cardLike = (entry) => `section.note-item:has(${cardButton(entry)}) .like-wrapper`;
const DETAIL_LIKE = '#noteContainer .engage-bar .like-wrapper';
// 点赞按钮的图标：#liked 已点赞，#like_b 没点赞
const likeIcon = (page, selector) => page.$eval(selector, (el) => el.querySelector('use').getAttribute('href'));
// 服务器收到的这篇笔记的点赞（like）/ 取消点赞（dislike）请求
const likesOf = (entry) => server.likeLog.filter((l) => l.kind === 'note' && l.id === entry.id).map((l) => l.action);
const waitForLike = (entry) => waitFor(() => likesOf(entry).length > 0, 10000, '服务器收到点赞请求');

/* ------------------------------------------------------------------ 场景 */
const feed = await openFeed();
current = feed;
// 清理后正好是「上级文件夹」的长度上限（50 个字符），最后一级会被舍去
const LONG_SUBDIR = '小红书收藏/2026年/travel-and-food-collections/超长的文件夹名字测试/第五级';

await scenario('首页每张卡片都有下载按钮，位置在点赞数前面', async () => {
  const total = Object.keys(NOTES).length;
  await waitFor(() => feed.evaluate((n) => document.querySelectorAll('section.note-item .xhsdl-btn--card').length === n, total), 15000, '卡片上的下载按钮');
  const cards = await feed.evaluate(() =>
    Array.from(document.querySelectorAll('section.note-item'), (card) => {
      const btn = card.querySelector('.xhsdl-btn--card');
      const row = card.querySelector('.card-bottom-wrapper').getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        noteId: btn.dataset.noteId,
        label: btn.textContent.trim(),
        inRow: btn.parentElement.classList.contains('card-bottom-wrapper'),
        beforeLike: !!btn.nextElementSibling && btn.nextElementSibling.classList.contains('like-wrapper'),
        fits: b.top >= row.top - 1 && b.bottom <= row.bottom + 1,
      };
    })
  );
  assert.deepEqual(
    cards.map((c) => c.noteId),
    Object.values(NOTES).map((e) => e.id)
  );
  for (const c of cards) {
    assert.equal(c.label, '下载');
    assert(c.inRow && c.beforeLike && c.fits, '按钮应在「作者 · 点赞」那一行里、点赞数前面：' + JSON.stringify(c));
  }
});

await scenario('卡片下载：jpg、png 原样保存，heic 转成 jpg，原图缺失时用网页图；下载完点赞', async () => {
  const e = NOTES.images;
  assert.equal(await likeIcon(feed, cardLike(e)), '#like_b', '测试开始时还没点赞');
  const toast = await clickAndWaitToast(feed, cardButton(e));
  const state = await feed.$eval(cardButton(e), (b) => b.dataset.state);
  assert.equal(toast.type, 'success', toast.text);
  assert.match(toast.text, /已保存 4 张图片/);
  assert(toast.text.includes(e.expect.folder), toast.text);
  assert(!toast.text.includes('点赞'), '点赞成功时不用额外提示：' + toast.text);
  assert.equal(state, 'done');
  await expectFolder(e.expect.folder, e.expect.files);
  assert(
    server.requests.some((r) => r.host === 'sns-img-bd.xhscdn.com' && r.path.endsWith('_heic?imageView2/format/jpg/q/95')),
    'HEIC 原图应该让 CDN 转成 JPG'
  );
  await waitForLike(e);
  assert.deepEqual(likesOf(e), ['like'], '只点一次赞');
  assert.equal(await likeIcon(feed, cardLike(e)), '#liked', '卡片上显示已点赞');
});

await scenario('视频笔记：保存 视频.mp4 和 封面.jpg；本来就点过赞的不再点（再点就取消了）', async () => {
  const e = NOTES.video;
  assert.equal(await likeIcon(feed, cardLike(e)), '#liked', '这篇笔记测试开始前就点过赞');
  const toast = await clickAndWaitToast(feed, cardButton(e));
  assert.equal(toast.type, 'success', toast.text);
  assert.match(toast.text, /已保存 2 个文件/);
  assert(!toast.text.includes('点赞'), toast.text);
  await expectFolder(e.expect.folder, e.expect.files);
  assert.deepEqual(likesOf(e), [], '不应该再点赞按钮');
  assert.equal(await likeIcon(feed, cardLike(e)), '#liked', '还是已点赞');
});

await scenario('Windows 保留名：标题 CON 存成 _CON，重复下载自动改名不覆盖，也不会取消点赞', async () => {
  const e = NOTES.reserved;
  let toast = await clickAndWaitToast(feed, cardButton(e));
  assert.equal(toast.type, 'success', toast.text);
  await expectFolder(e.expect.folder, e.expect.files);
  await waitForLike(e);
  toast = await clickAndWaitToast(feed, cardButton(e));
  assert.equal(toast.type, 'success', toast.text);
  await expectFolder(e.expect.folder, { '01.jpg': 'photoJpg', '01 (1).jpg': 'photoJpg' });
  assert.deepEqual(likesOf(e), ['like'], '第二次下载时已经点过赞，不能再点');
  assert.equal(await likeIcon(feed, cardLike(e)), '#liked');
});

await scenario('长标题 + 多级上级文件夹 + PNG 格式：路径不超过 Windows 限制；关掉自动点赞后不点赞', async () => {
  const e = NOTES.longTitle;
  await setSettings({ subDir: LONG_SUBDIR, imageFormat: 'png', likeAfterDownload: false });
  try {
    const toast = await clickAndWaitToast(feed, cardButton(e));
    assert.equal(toast.type, 'success', toast.text);
    assert(!toast.text.includes('点赞'), toast.text);
    const sub = X.sanitizePath(LONG_SUBDIR);
    const folder = X.folderNameFor(e.note);
    assert.equal(sub.length, X.LIMITS.subDirUnits, '上级文件夹应正好达到长度上限：' + sub);
    assert.equal(folder.length, X.LIMITS.folder.maxUnits, '文件夹名应正好达到长度上限：' + folder);
    const rel = sub + '/' + folder;
    const dir = await expectFolder(rel, { '01.png': 'convertedPng', '02.png': 'photoPng' });
    log(`  保存位置：…/${rel}/（完整路径 ${path.join(dir, '01.png').length} 个字符）`);
    assert.deepEqual(likesOf(e), [], '关掉「下载后自动点赞」后不点赞');
    assert.equal(await likeIcon(feed, cardLike(e)), '#like_b');
  } finally {
    await setSettings({ subDir: '', imageFormat: 'original', likeAfterDownload: true });
  }
});

await scenario('笔记详情页：按钮显示张数和保存位置；没有标题时用正文第一句命名；点的是笔记的赞，不是评论的', async () => {
  const e = NOTES.untitled;
  const page = watch(await browser.newPage(), 'detail');
  current = page;
  await page.goto(noteUrl(e), { waitUntil: 'domcontentloaded' });
  const sel = '#noteContainer .xhsdl-detail-bar .xhsdl-btn';
  await page.waitForSelector(sel, { timeout: 15000 });
  await waitFor(() => page.$eval(sel, (b) => b.textContent.trim() === '下载全部图片（2 张）'), 10000, '按钮上显示「下载全部图片（2 张）」');
  const hint = `保存到：下载 / ${e.expect.folder} /`;
  await waitFor(() => page.$eval('#noteContainer .xhsdl-detail-hint', (el, hint) => el.textContent === hint, hint), 10000, '按钮下方显示「' + hint + '」');
  assert.equal(await likeIcon(page, DETAIL_LIKE), '#like_b', '测试开始时还没点赞');
  const toast = await clickAndWaitToast(page, sel);
  assert.equal(toast.type, 'success', toast.text);
  assert(!toast.text.includes('点赞'), toast.text);
  await expectFolder(e.expect.folder, e.expect.files);
  await waitForLike(e);
  assert.deepEqual(likesOf(e), ['like'], '只点一次赞');
  assert.equal(await likeIcon(page, DETAIL_LIKE), '#liked', '底部互动栏显示已点赞');
  assert.equal(await likeIcon(page, '#noteContainer .comment-item .like-wrapper'), '#like_b', '评论的赞没被点');
  assert.deepEqual(server.likeLog.filter((l) => l.kind === 'comment'), [], '没有给评论点赞');
  await page.close();
});

await scenario('没登录：照常下载，不点赞，也不弹出登录框', async () => {
  const e = NOTES.reserved;
  const page = watch(await browser.newPage(), 'guest');
  current = page;
  await page.goto('https://www.xiaohongshu.com/explore?guest=1', { waitUntil: 'domcontentloaded' });
  const before = server.likeLog.length;
  const toast = await clickAndWaitToast(page, cardButton(e));
  assert.equal(toast.type, 'success', toast.text);
  assert.match(toast.text, /没登录小红书，没有自动点赞/);
  await expectFolder(e.expect.folder, { '01.jpg': 'photoJpg', '01 (1).jpg': 'photoJpg', '01 (2).jpg': 'photoJpg' });
  assert.equal(await page.$('.login-modal'), null, '不应该弹出登录框');
  assert.equal(await likeIcon(page, cardLike(e)), '#like_b');
  assert.equal(server.likeLog.length, before, '没登录时不发点赞请求');
  await page.close();
});

await scenario('设置页：输入 Windows 绝对路径时去掉盘符并提示', async () => {
  const page = watch(await browser.newPage(), 'popup');
  current = page;
  await page.setViewport({ width: 340, height: 600 });
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);
  await page.waitForSelector('input[name="subDir"]');
  await page.type('input[name="subDir"]', 'D:\\图片\\小红书');
  await waitFor(() => page.$eval('#pathPreview', (el) => el.textContent === '下载 / 图片 / 小红书 / 笔记标题 / 01.jpg'), 5000, '路径预览');
  assert.equal(await page.$eval('#pathWarn', (el) => el.hidden), false, '应该显示绝对路径的提示');
  await waitFor(() => page.evaluate(() => chrome.storage.sync.get('subDir').then((s) => s.subDir === '图片/小红书')), 5000, '设置保存为「图片/小红书」');
  const likeSwitch = 'input[name="likeAfterDownload"]';
  const storedLike = (want) => () => page.evaluate((want) => chrome.storage.sync.get({ likeAfterDownload: true }).then((s) => s.likeAfterDownload === want), want);
  assert.equal(await page.$eval(likeSwitch, (el) => el.checked), true, '「下载后自动点赞」默认打开');
  await page.click(likeSwitch);
  await waitFor(storedLike(false), 5000, '关掉「下载后自动点赞」后保存');
  await page.click(likeSwitch);
  await waitFor(storedLike(true), 5000, '重新打开「下载后自动点赞」后保存');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false, '设置页不应出现横向滚动条');
  await page.screenshot({ path: path.join(OUT_DIR, 'popup.png') });
  await page.evaluate(() => chrome.storage.sync.set({ subDir: '' }));
  await page.close();
});

await scenario('下载目录里没有多余或未完成的文件', async () => {
  const top = listDir(downloadDir);
  const expected = [NOTES.images, NOTES.video, NOTES.untitled, NOTES.reserved].map((e) => e.expect.folder);
  expected.push(X.sanitizePath(LONG_SUBDIR).split('/')[0]);
  assert.deepEqual(top, expected.sort());
  const all = walk(downloadDir);
  assert(!all.some((f) => f.endsWith('.crdownload')), '有未完成的下载：' + all.join(', '));
  const records = await downloadRecords();
  const bad = records.filter((r) => r.state !== 'complete');
  assert.deepEqual(bad, [], '所有下载都应该完成');
  assert.equal(records.length, all.length, '下载记录数和文件数一致');
  assert.deepEqual(
    server.likeLog,
    [NOTES.images, NOTES.reserved, NOTES.untitled].map((e) => ({ kind: 'note', action: 'like', id: e.id })),
    '只给下载过、原来没点赞的笔记各点了一次赞，没有取消过任何点赞'
  );
});

/* ------------------------------------------------------------------ 结果 */
const failed = results.filter((r) => !r.ok);
console.log('');
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}`);
console.log(`\n${results.length - failed.length}/${results.length} 个场景通过（${os.type()}，${await browser.version()}）`);
const noisy = logs.filter((l) => !/favicon|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(l));
if (noisy.length) console.log('\n浏览器日志：\n  ' + noisy.join('\n  '));
await browser.close();
await server.close();
process.exitCode = failed.length ? 1 : 0;
