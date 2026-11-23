/*
 * 小红书图片下载 · 后台 Service Worker
 *
 * 收到内容脚本发来的下载任务后，逐个文件：
 *   1. 只请求文件头 64 字节，确认地址可用并识别真实格式（jpg/png/webp/heic/mp4…）
 *   2. 按设置决定是否让 CDN 转格式（默认只把 heic/avif 转成 jpg）
 *   3. 用 chrome.downloads 保存为「下载目录/<笔记标题>/01.jpg」
 *   4. 等待下载完成；失败就换下一个候选地址（原图 → 网页图）
 */
importScripts('shared.js');

const X = self.XHSDL;
const CONCURRENCY = 3;
const PROBE_TIMEOUT_MS = 20000;
const POLL_MS = 500;

// 这些错误和保存位置有关（路径太长、文件夹建不出来、没有写入权限），换一个更短的备用文件夹再试；
// 其他错误（网络、服务器）换下一个下载地址再试
const PATH_ERRORS = new Set(['FILE_NAME_TOO_LONG', 'FILE_ACCESS_DENIED', 'FILE_FAILED']);

const ERROR_TEXT = {
  FILE_NAME_TOO_LONG: '文件路径太长（Windows 限制 260 个字符），请在浏览器设置里把下载位置换到更短的路径',
  FILE_ACCESS_DENIED: '没有权限写入下载文件夹（可能被安全软件拦截）',
  FILE_FAILED: '写入文件失败',
  FILE_TRANSIENT_ERROR: '写入文件失败，请重试',
  FILE_NO_SPACE: '磁盘空间不足',
  FILE_TOO_LARGE: '文件太大，所在磁盘不支持',
  FILE_VIRUS_INFECTED: '被安全软件拦截',
  FILE_BLOCKED: '被系统策略拦截',
  FILE_SECURITY_CHECK_FAILED: '被安全检查拦截',
  NETWORK_FAILED: '网络连接失败',
  NETWORK_TIMEOUT: '网络超时',
  NETWORK_DISCONNECTED: '网络已断开',
  NETWORK_SERVER_DOWN: '图片服务器无法访问',
  SERVER_FORBIDDEN: '图片服务器拒绝访问',
  SERVER_UNAUTHORIZED: '图片服务器拒绝访问',
  SERVER_FAILED: '图片服务器出错',
  SERVER_BAD_CONTENT: '图片服务器返回了错误内容',
  USER_SHUTDOWN: '浏览器已关闭，下载中断',
  CRASH: '浏览器异常退出，下载中断',
};

function describeError(code) {
  return ERROR_TEXT[code] || (/^SERVER_|^NETWORK_/.test(code) ? '下载失败（' + code + '）' : code);
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && X.isXhsMediaHost(u.hostname);
  } catch (_) {
    return false;
  }
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-63' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    let bytes = new Uint8Array(0);
    if (res.body) {
      const reader = res.body.getReader();
      try {
        const { value } = await reader.read();
        if (value) bytes = value;
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    if (!bytes.length) return { ok: false, error: '服务器返回了空文件' };
    const mime = res.headers.get('content-type') || '';
    const ext = X.sniffExt(bytes) || X.extFromMime(mime);
    if (!ext && /text|html|xml|json/i.test(mime)) return { ok: false, error: '返回的不是图片/视频（' + mime + '）' };
    return { ok: true, ext };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? '请求超时' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

function waitForDownload(id, onFraction) {
  return new Promise((resolve) => {
    const check = async () => {
      let item;
      try {
        [item] = await chrome.downloads.search({ id });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
        return;
      }
      if (!item) return resolve({ ok: false, error: '下载记录被删除' });
      if (item.state === 'complete') return resolve({ ok: true, item });
      if (item.state === 'interrupted') return resolve({ ok: false, error: item.error || 'INTERRUPTED' });
      if (onFraction && item.totalBytes > 0) onFraction(Math.min(0.99, item.bytesReceived / item.totalBytes));
      setTimeout(check, POLL_MS);
    };
    check();
  });
}

// 原图是 heic 等格式、或用户选了 JPG / PNG 时，改用 CDN 按原分辨率转好格式的地址
async function maybeConvert(url, ext, format) {
  const want = X.targetImageExt(ext, format);
  const convUrl = want && X.convertedImageUrl(url, want);
  if (!convUrl) return { url, ext };
  const p = await probe(convUrl);
  return p.ok && p.ext === want ? { url: convUrl, ext: want } : { url, ext };
}

// 清掉失败的下载记录和残留的临时文件
function discard(id) {
  chrome.downloads
    .cancel(id)
    .catch(() => {})
    .then(() => chrome.downloads.erase({ id }))
    .catch(() => {});
}

// dirs：按顺序尝试的保存文件夹（标题文件夹 → 备用短名字）。
// place.dir 在同一个任务的所有文件之间共享：某个文件夹被系统拒绝后，后面的文件直接用下一个，
// 这样一篇笔记的文件尽量待在同一个文件夹里
async function downloadItem(item, dirs, place, format, onFraction) {
  let lastError = '没有可用的下载地址';
  for (const candidate of item.urls) {
    if (place.dir >= dirs.length) break;
    const p = await probe(candidate);
    if (!p.ok) {
      lastError = p.error;
      continue;
    }
    let url = candidate;
    let ext = p.ext || (item.kind === 'video' ? 'mp4' : 'jpg');
    if (item.kind === 'image') ({ url, ext } = await maybeConvert(candidate, ext, format));
    while (place.dir < dirs.length) {
      const d = place.dir;
      // 几个文件同时下载，可能都在同一个文件夹上失败，只往后挪一次
      const skipDir = () => {
        if (place.dir === d) place.dir = d + 1;
      };
      let id;
      try {
        id = await chrome.downloads.download({ url, filename: `${dirs[d]}/${item.name}.${ext}`, conflictAction: 'uniquify', saveAs: false });
      } catch (e) {
        lastError = String((e && e.message) || e);
        if (!/filename/i.test(lastError)) break; // 不是文件名的问题 → 换下一个地址
        skipDir(); // 文件夹名不被接受 → 换备用文件夹
        continue;
      }
      const r = await waitForDownload(id, onFraction);
      if (r.ok) return { ok: true, id, dir: dirs[d] };
      if (r.error === 'USER_CANCELED') return { ok: false, error: '已取消' };
      lastError = describeError(r.error);
      discard(id);
      if (!PATH_ERRORS.has(r.error)) break; // 网络 / 服务器问题 → 换下一个地址
      skipDir();
    }
  }
  return { ok: false, error: lastError };
}

async function runJob(job, post) {
  const sub = X.sanitizePath(job.subDir);
  const prefix = sub ? sub + '/' : '';
  const fallbackFolder = X.sanitizeSegment(job.fallbackFolder) || 'xiaohongshu';
  const folder = X.sanitizeSegment(job.folder) || fallbackFolder;
  // 最后一个备用位置不带上级文件夹，路径最短
  const dirs = X.dedupe([prefix + folder, prefix + fallbackFolder, fallbackFolder]);
  const place = { dir: 0 };
  const format = ['original', 'jpg', 'png'].includes(job.format) ? job.format : 'original';

  const items = (Array.isArray(job.items) ? job.items : [])
    .map((it, i) => ({
      name: X.sanitizeSegment(it && it.name, { maxChars: 40 }) || String(i + 1).padStart(2, '0'),
      kind: it && it.kind === 'video' ? 'video' : 'image',
      urls: (it && Array.isArray(it.urls) ? it.urls : []).filter((u) => typeof u === 'string' && isAllowedUrl(u)).slice(0, 12),
    }))
    .filter((it) => it.urls.length > 0);

  const total = items.length;
  const fractions = new Array(total).fill(0);
  const errors = [];
  let done = 0;
  let failed = 0;
  let firstId = null;
  let savedDir = null;
  let lastEmit = 0;

  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 300) return;
    lastEmit = now;
    const sum = fractions.reduce((a, b) => a + b, 0);
    post({ type: 'progress', done, failed, total, percent: total ? Math.floor((sum / total) * 100) : 100 });
  };

  emit(true);
  let next = 0;
  const worker = async () => {
    while (next < total) {
      const idx = next++;
      const item = items[idx];
      const r = await downloadItem(item, dirs, place, format, (f) => {
        fractions[idx] = f;
        emit(false);
      });
      fractions[idx] = 1;
      if (r.ok) {
        done++;
        if (firstId === null) firstId = r.id;
        if (savedDir === null) savedDir = r.dir;
      } else {
        failed++;
        errors.push(`${item.name}：${r.error}`);
      }
      emit(true);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  return { type: 'done', ok: total > 0 && failed === 0, done, failed, total, dir: savedDir || dirs[0], errors, firstId };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xhsdl-job') return;
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
  });
  const post = (msg) => {
    if (!connected) return;
    try {
      port.postMessage(msg);
    } catch (_) {
      connected = false;
    }
  };
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'start') return;
    runJob(msg.job || {}, post).then(post, (e) =>
      post({ type: 'done', ok: false, done: 0, failed: 0, total: 0, errors: [String((e && e.message) || e)], firstId: null })
    );
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'show' && Number.isInteger(msg.id)) {
    // 只允许打开本插件下载的文件所在文件夹
    chrome.downloads
      .search({ id: msg.id })
      .then(([item]) => {
        if (item && item.byExtensionId === chrome.runtime.id) {
          if (item.exists === false) chrome.downloads.showDefaultFolder();
          else chrome.downloads.show(msg.id);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
