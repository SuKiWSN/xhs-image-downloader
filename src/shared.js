/*
 * 小红书图片下载 · 公共工具
 * 同时被内容脚本（页面中）和后台 Service Worker 加载，挂在 globalThis.XHSDL 上。
 */
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    imageFormat: 'original', // original 原图 | jpg | png
    downloadVideo: true, // 视频笔记：同时下载视频文件
    downloadLive: false, // 实况图（Live Photo）：同时下载动态视频
    subDir: '', // 下载目录下的上级文件夹，留空 = 直接放在下载目录
    likeAfterDownload: true, // 下载完成后给笔记点赞，当作「已下载」的标记
  });

  // 笔记链接：/explore/<id>、/discovery/item/<id>、/search_result/<id>、/user/profile/<uid>/<id>
  const NOTE_PATH_RE = /\/(?:explore|discovery\/item|search_result|user\/profile\/[^/?#]+)\/([0-9a-f]{24})(?=[/?#]|$)/i;

  function dedupe(list) {
    const seen = new Set();
    const out = [];
    for (const x of list) {
      if (x && !seen.has(x)) {
        seen.add(x);
        out.push(x);
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- 文件名清理
   * Chrome 的 downloads API 在所有系统上都按同一套「可移植」规则检查路径
   * （Chromium net::IsSafePortablePathComponent），所以这里的规则在 Windows / macOS / Linux 上一致：
   *  - 任何位置都不能有 " ~ * / : < > ? \ | 、控制字符(Cc)、格式字符(Cf，如表情里的零宽连接符)、非字符
   *  - 开头和结尾不能是空白或「.」
   *  - 不能是 Windows 保留名（CON、NUL、COM1…），扩展名不能是 lnk / local / scf / {CLSID}
   * 不满足就会报 "Invalid filename"。这里把标题处理成合法且尽量接近原文的名字：
   * 非法符号换成全角同形字符（/ → ／，? → ？），其余不可见字符直接去掉。
   *
   * 长度另有各系统自己的限制，下面的上限取了它们的交集：
   *  - Windows：完整路径不能超过 259 个字符（Chrome 下载时还会临时加上 11 个字符的 .crdownload），
   *    文件夹路径不能超过 247 个字符。「上级文件夹」最多 50 个字符、标题文件夹最多 60 个字符、
   *    文件名最多十几个字符，下载目录本身只要不超过约 115 个字符就不会超限。
   *  - Linux / macOS：每一级名字不能超过 255 字节（UTF-8，一个汉字 3 字节）；
   *    加密的 home 目录（eCryptfs）只有 143 字节，所以文件夹名限制在 140 字节以内。
   */
  const FULLWIDTH = { '/': '／', '\\': '＼', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜', '~': '～' };
  const ILLEGAL_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}]/gu;
  const ENDS_RE = /^[\p{White_Space}.]+|[\p{White_Space}.]+$/gu;
  // Windows 设备名：CON、NUL、COM0-9、LPT0-9（含上标 ¹²³）、CONIN$ 等，带扩展名（CON.txt、CON .txt）也算
  const RESERVED_RE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)|^(?:desktop\.ini|thumbs\.db)$/i;
  const LIMITS = Object.freeze({
    folder: { maxChars: 60, maxUnits: 60, maxBytes: 140 }, // 标题文件夹
    subDirSegment: { maxChars: 40, maxUnits: 40, maxBytes: 120 }, // 上级文件夹的每一级
    subDirUnits: 50, // 上级文件夹总长度（含分隔符）
    subDirDepth: 5,
  });

  let encoder = null;
  function utf8Length(str) {
    encoder = encoder || new TextEncoder();
    return encoder.encode(str).length;
  }

  function graphemes(str) {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      try {
        return Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(str), (s) => s.segment);
      } catch (_) {
        /* 退回按码点切分 */
      }
    }
    return Array.from(str);
  }

  // 把一段文字处理成可以当文件夹名 / 文件名的字符串；处理后为空时返回 ''。
  // maxChars 按用户看到的字数（字素）计，maxUnits 按 Windows 路径长度（UTF-16 码元）计，maxBytes 按 UTF-8 字节计
  function sanitizeSegment(input, opts) {
    const maxChars = (opts && opts.maxChars) || LIMITS.folder.maxChars;
    const maxUnits = (opts && opts.maxUnits) || LIMITS.folder.maxUnits;
    const maxBytes = (opts && opts.maxBytes) || LIMITS.folder.maxBytes;
    let s = input == null ? '' : String(input);
    try {
      s = s.normalize('NFC');
    } catch (_) {
      /* ignore */
    }
    s = s
      .replace(/[/\\:*?"<>|~]/g, (c) => FULLWIDTH[c])
      .replace(/\s+/gu, ' ')
      .replace(ILLEGAL_RE, '')
      .replace(/ {2,}/g, ' ')
      .replace(ENDS_RE, '');
    // 按字素截断，不会把一个表情或「字 + 声调符号」从中间切开
    let parts = graphemes(s);
    if (parts.length > maxChars) parts = parts.slice(0, maxChars);
    const fits = (str) => str.length <= maxUnits && utf8Length(str) <= maxBytes;
    while (parts.length && !fits(parts.join(''))) parts.pop();
    s = finishName(parts.join(''));
    // 补上的「_」可能让长度超出 1 个字符，再去掉一个字
    while (s && !fits(s)) {
      parts.pop();
      s = finishName(parts.join(''));
    }
    return s;
  }

  // 截断后再处理一次首尾，并避开 Windows 保留名和危险扩展名
  function finishName(str) {
    const s = str.replace(ENDS_RE, '');
    if (!s) return '';
    if (RESERVED_RE.test(s)) return '_' + s;
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
    if (ext === 'lnk' || ext === 'local' || ext === 'scf' || (ext[0] === '{' && ext[ext.length - 1] === '}')) return s + '_';
    return s;
  }

  // 用户设置的上级文件夹，允许 "小红书/收藏" 这种多级写法（/ 和 \ 都行）。
  // 插件只能保存到浏览器的下载目录里，所以写成 C:\图片、~/Pictures 这样的绝对路径时会去掉盘符和 ~
  function sanitizePath(input) {
    const raw = String(input == null ? '' : input).split(/[/\\]+/);
    if (raw.length && /^\s*(?:[a-z]:|~)\s*$/i.test(raw[0])) raw.shift();
    const out = [];
    let units = 0;
    for (const p of raw) {
      const seg = sanitizeSegment(p, LIMITS.subDirSegment);
      if (!seg) continue;
      const add = seg.length + (out.length ? 1 : 0);
      if (out.length >= LIMITS.subDirDepth || units + add > LIMITS.subDirUnits) break;
      out.push(seg);
      units += add;
    }
    return out.join('/');
  }

  // 输入看起来像绝对路径（C:\…、D:/…、\\server、~/…、/Users/…、/home/…）
  function looksLikeAbsolutePath(input) {
    return /^\s*(?:[a-z]:(?:[/\\]|\s*$)|\\\\|~(?:[/\\]|\s*$)|\/(?:users|home|mnt|media|volumes|root|tmp)(?:\/|$))/i.test(String(input || ''));
  }

  /* ---------------------------------------------------------------- 标题 → 文件夹名 */
  function firstLineOfDesc(desc) {
    const text = String(desc || '')
      .replace(/#[^#\n]{1,40}?\[话题\]#/g, ' ') // 话题标签：#xxx[话题]#
      .replace(/\[[^[\]\n]{1,12}R\]/g, ''); // 小红书表情：[笑哭R]
    return (
      text
        .split(/\n+/)
        .map((l) => l.trim())
        .find(Boolean) || ''
    );
  }

  // 优先用笔记标题；没有标题时用正文第一句（从卡片或详情下载都得到同一个名字），
  // 再退回页面上显示的标题，最后才用笔记 ID
  function folderNameFor(note, titleHint) {
    const candidates = [
      [note && note.title, LIMITS.folder.maxChars],
      [firstLineOfDesc(note && note.desc), 40],
      [titleHint, 40],
    ];
    for (const [text, maxChars] of candidates) {
      const name = sanitizeSegment(text, Object.assign({}, LIMITS.folder, { maxChars }));
      if (name) return name;
    }
    const id = (note && note.noteId) || '';
    return sanitizeSegment('小红书笔记' + (id ? '_' + id : ''));
  }

  /* ---------------------------------------------------------------- 图片 / 视频地址 */
  // 原图：sns-img-bd.xhscdn.com/<token> 返回上传时的原始文件（比网页里的 webp 预览图清晰），
  // 原始格式可能是 jpg / png / webp，也可能是苹果的 heic。
  // 在原图地址后加 imageView2 参数可以让 CDN 按原分辨率转格式。
  const IMAGE_ORIGIN_HOSTS = ['https://sns-img-bd.xhscdn.com/', 'https://ci.xiaohongshu.com/'];
  const ORIGIN_HOST_RE = /^(?:sns-img-[a-z0-9]+\.xhscdn\.com|ci\.xiaohongshu\.com)$/i;
  const CONVERT_QUERY = { jpg: '?imageView2/format/jpg/q/95', png: '?imageView2/format/png' };
  const TOKEN_RE = /^[A-Za-z0-9_\-./]+$/;

  function isToken(t) {
    return typeof t === 'string' && t.length > 0 && TOKEN_RE.test(t) && !t.includes('..') && !t.startsWith('/');
  }

  function toHttps(url) {
    if (typeof url !== 'string' || !url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    return url.replace(/^http:\/\//i, 'https://');
  }

  function isXhsMediaHost(hostname) {
    return /(^|\.)xhscdn\.com$/i.test(hostname) || /(^|\.)xiaohongshu\.com$/i.test(hostname);
  }

  // 从图片地址里取出图片 token，例如
  //   http://sns-webpic-qc.xhscdn.com/202611230041/6ac4…e8ed/notes_pre_post/1040g3k8…!nd_dft_wlteh_webp_3
  //   → notes_pre_post/1040g3k8…
  function extractImageToken(url) {
    if (typeof url !== 'string' || !url) return '';
    let u;
    try {
      u = new URL(toHttps(url));
    } catch (_) {
      return '';
    }
    if (!/^https?:$/.test(u.protocol) || !isXhsMediaHost(u.hostname)) return '';
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch (_) {
      /* keep raw */
    }
    const parts = path.split('!')[0].split('/').filter(Boolean);
    if (parts.length >= 3 && /^\d{8,14}$/.test(parts[0]) && /^[0-9a-f]{16,64}$/i.test(parts[1])) parts.splice(0, 2);
    const token = parts.join('/');
    return isToken(token) ? token : '';
  }

  // 一张图片的候选下载地址（按优先级）：原图 → 网页默认图 → 预览图
  function imageCandidates(img) {
    if (!img || typeof img !== 'object') return [];
    const info = Array.isArray(img.infoList) ? img.infoList : [];
    const dft = info.find((i) => i && i.imageScene === 'WB_DFT');
    const prv = info.find((i) => i && i.imageScene === 'WB_PRV');
    const pageUrls = [img.urlDefault, dft && dft.url, img.url, img.urlPre, prv && prv.url, img.src];
    let token = isToken(img.fileId) ? img.fileId : '';
    if (!token) {
      for (const u of pageUrls) {
        token = extractImageToken(u);
        if (token) break;
      }
    }
    const out = [];
    if (token) for (const host of IMAGE_ORIGIN_HOSTS) out.push(host + token);
    if (isToken(img.traceId)) out.push(IMAGE_ORIGIN_HOSTS[0] + img.traceId);
    for (const u of pageUrls) if (u) out.push(toHttps(u));
    return dedupe(out);
  }

  // 根据原图的真实格式和用户设置，决定要不要转格式；返回目标扩展名，不需要转换时返回 ''
  //   原图：保留原格式，只把 heic / avif 转成 jpg（很多设备和网站打不开这两种格式）
  //   JPG / PNG：不是该格式的都转换，本来就是的保持原文件
  function targetImageExt(actualExt, format) {
    if (format === 'jpg') return actualExt === 'jpg' ? '' : 'jpg';
    if (format === 'png') return actualExt === 'png' ? '' : 'png';
    return actualExt === 'heic' || actualExt === 'avif' ? 'jpg' : '';
  }

  // 原图地址 → 让 CDN 转成指定格式的地址（只对原图服务器的地址有效）
  function convertedImageUrl(url, ext) {
    const q = CONVERT_QUERY[ext];
    if (!q) return '';
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.search || !ORIGIN_HOST_RE.test(u.hostname)) return '';
      return u.href + q;
    } catch (_) {
      return '';
    }
  }

  // 从 stream（{ h264: [...], h265: [...] } 或新版的 { EF4: [...], EF5: [...] }）中挑一路视频：
  // 优先完整 mp4（兼容性最好），其次分辨率高、码率高的
  function pickVideoUrls(stream) {
    const all = [];
    if (stream && typeof stream === 'object') {
      for (const list of Object.values(stream)) {
        if (!Array.isArray(list)) continue;
        for (const s of list) {
          if (s && (s.masterUrl || (Array.isArray(s.backupUrls) && s.backupUrls.length))) all.push(s);
        }
      }
    }
    if (!all.length) return [];
    const isMp4 = (s) => (String(s.format || '').toLowerCase() === 'mp4' || /\.mp4(?:[?#]|$)/i.test(s.masterUrl || '') ? 1 : 0);
    const pixels = (s) => (Number(s.width) || 0) * (Number(s.height) || 0);
    const rate = (s) => Number(s.avgBitrate || s.videoBitrate || 0) || 0;
    all.sort((a, b) => isMp4(b) - isMp4(a) || pixels(b) - pixels(a) || rate(b) - rate(a));
    const best = all[0];
    return dedupe([best.masterUrl].concat(best.backupUrls || []).map(toHttps));
  }

  function videoCandidates(note) {
    const v = note && note.video;
    if (!v || typeof v !== 'object') return [];
    const out = pickVideoUrls(v.media && v.media.stream);
    const key = v.consumer && v.consumer.originVideoKey;
    if (isToken(key)) out.push('https://sns-video-bd.xhscdn.com/' + key);
    return dedupe(out);
  }

  function hasMedia(note) {
    return !!note && typeof note === 'object' && ((Array.isArray(note.imageList) && note.imageList.length > 0) || !!note.video);
  }

  // 点开笔记的瞬间，页面里先放的是用卡片信息拼出来的占位数据（只有封面一张图，没有 time / desc），
  // 完整数据要等接口返回后才替换进来。占位数据不能拿来下载。
  function isCompleteNote(note) {
    return hasMedia(note) && (note.time != null || note.lastUpdateTime != null || typeof note.desc === 'string');
  }

  // 笔记数据 → 下载计划：{ folder, items: [{ name, kind, urls }] }
  function buildPlan(note, settings, titleHint) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const images = Array.isArray(note && note.imageList) ? note.imageList : [];
    const isVideo = !!note && note.type === 'video';
    const items = [];
    if (isVideo) {
      if (images[0]) items.push({ name: '封面', kind: 'image', urls: imageCandidates(images[0]) });
      if (s.downloadVideo) {
        const urls = videoCandidates(note);
        if (urls.length) items.push({ name: '视频', kind: 'video', urls });
      }
    } else {
      const width = Math.max(2, String(images.length).length);
      images.forEach((img, i) => {
        const base = String(i + 1).padStart(width, '0');
        items.push({ name: base, kind: 'image', urls: imageCandidates(img) });
        if (s.downloadLive && img && img.livePhoto) {
          const urls = pickVideoUrls(img.stream);
          if (urls.length) items.push({ name: base + '_实况', kind: 'video', urls });
        }
      });
    }
    const usable = items.filter((it) => it.urls.length > 0);
    return {
      folder: folderNameFor(note, titleHint),
      items: usable,
      isVideo,
      imageCount: usable.filter((it) => it.kind === 'image').length,
      videoCount: usable.filter((it) => it.kind === 'video').length,
    };
  }

  /* ---------------------------------------------------------------- 文件格式识别 */
  function ascii(bytes, start, end) {
    let s = '';
    for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // 根据文件头判断真实格式（CDN 常返回 application/octet-stream，不能只看 Content-Type）
  function sniffExt(bytes) {
    if (!bytes || bytes.length < 4) return '';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'png';
    if (ascii(bytes, 0, 4) === 'GIF8') return 'gif';
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
    const box = ascii(bytes, 4, 8);
    if (box === 'ftyp') {
      const brands = ascii(bytes, 8, Math.min(bytes.length, 64)).toLowerCase();
      const major = brands.slice(0, 4);
      if (major === 'avif' || major === 'avis') return 'avif';
      if (/^(?:heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(major)) return brands.includes('avif') ? 'avif' : 'heic';
      if (major.startsWith('qt')) return 'mov';
      return 'mp4';
    }
    if (box === 'styp' || box === 'moof' || box === 'sidx' || box === 'moov') return 'mp4';
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
    return '';
  }

  function extFromMime(mime) {
    const m = String(mime || '').toLowerCase().split(';')[0].trim();
    const map = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/pjpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/heic': 'heic',
      'image/heif': 'heic',
      'image/avif': 'avif',
      'image/bmp': 'bmp',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
    };
    return map[m] || '';
  }

  /* ---------------------------------------------------------------- 页面数据 */
  // 从笔记页 HTML 中取出 window.__INITIAL_STATE__（里面有完整的图片列表）
  function parseInitialState(html) {
    if (typeof html !== 'string') return null;
    const m = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
    if (!m) return null;
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    let json = html
      .slice(start, end < 0 ? undefined : end)
      .trim()
      .replace(/;+\s*$/, '');
    // 页面里的数据是 JS 字面量，含有 undefined，需要换成 null 才能 JSON.parse
    json = json.replace(/([:,[]\s*)undefined(?=\s*[,}\]])/g, '$1null');
    try {
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- 点赞按钮 */
  // 小红书点赞按钮里的图标：没点赞是 <use href="#like_b">，已点赞是 <use href="#liked">。
  // 返回 true 已点赞 / false 没点赞 / null 认不出。认不出时不能去点：点赞按钮是开关，点错会取消点赞
  function likeIconState(href) {
    const s = String(href || '');
    const hash = s.lastIndexOf('#');
    const name = hash < 0 ? '' : s.slice(hash + 1).toLowerCase();
    if (/^liked/.test(name)) return true;
    if (/^like(?!d)/.test(name)) return false;
    return null;
  }

  function parseNoteUrl(href, base) {
    if (!href) return null;
    try {
      const u = new URL(href, base || 'https://www.xiaohongshu.com/');
      const m = u.pathname.match(NOTE_PATH_RE);
      if (!m) return null;
      return {
        noteId: m[1],
        xsecToken: u.searchParams.get('xsec_token') || '',
        xsecSource: u.searchParams.get('xsec_source') || '',
      };
    } catch (_) {
      return null;
    }
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS,
    NOTE_PATH_RE,
    LIMITS,
    dedupe,
    sanitizeSegment,
    sanitizePath,
    looksLikeAbsolutePath,
    firstLineOfDesc,
    folderNameFor,
    toHttps,
    isXhsMediaHost,
    extractImageToken,
    imageCandidates,
    targetImageExt,
    convertedImageUrl,
    pickVideoUrls,
    videoCandidates,
    hasMedia,
    isCompleteNote,
    buildPlan,
    sniffExt,
    extFromMime,
    parseInitialState,
    likeIconState,
    parseNoteUrl,
  });

  root.XHSDL = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
