/*
 * 小红书图片下载 · 内容脚本
 *  - 在每个笔记卡片底部（作者 / 点赞那一行）插入「下载」按钮
 *  - 在打开的笔记详情里（正文、日期下方）插入「下载全部图片」按钮
 * 点击后拿到这篇笔记的完整图片列表，交给后台保存到「下载/<笔记标题>/」文件夹；
 * 下载完成后给这篇笔记点赞，当作「已下载」的标记（可在设置里关闭）。
 */
(() => {
  'use strict';
  const X = globalThis.XHSDL;
  if (!X || globalThis.__xhsdlContentLoaded) return;
  globalThis.__xhsdlContentLoaded = true;

  const LOG = '[小红书图片下载]';
  const RELOAD_HINT = '插件刚刚更新过，请刷新页面后再下载';
  // 笔记详情：单独打开的笔记页面，或从列表点开的弹窗
  const DETAIL_CONTAINERS = '#noteContainer, .note-detail-mask .note-container';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function extensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ 设置 */
  let settings = Object.assign({}, X.DEFAULT_SETTINGS);

  function loadSettings() {
    return chrome.storage.sync
      .get(X.DEFAULT_SETTINGS)
      .then((s) => (settings = Object.assign({}, X.DEFAULT_SETTINGS, s)))
      .catch(() => settings);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in X.DEFAULT_SETTINGS) settings[key] = change.newValue === undefined ? X.DEFAULT_SETTINGS[key] : change.newValue;
    }
    scheduleScan();
  });

  /* ------------------------------------------------------------------ 与页面桥接脚本通信 */
  const pending = new Map();
  let seq = 0;

  window.addEventListener('xhsdl:response', (event) => {
    if (typeof event.detail !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch (_) {
      return;
    }
    const done = msg && pending.get(msg.id);
    if (done) {
      pending.delete(msg.id);
      done(msg);
    }
  });

  function askPage(action, payload) {
    return new Promise((resolve) => {
      const id = 'q' + Date.now().toString(36) + (++seq).toString(36);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 1000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg.error ? null : msg.result);
      });
      window.dispatchEvent(new CustomEvent('xhsdl:request', { detail: JSON.stringify(Object.assign({ id, action }, payload)) }));
    });
  }

  /* ------------------------------------------------------------------ 获取笔记数据 */
  // 打开笔记页面的 HTML（与点开笔记时浏览器请求的地址相同），从中解析完整的图片列表
  async function fetchNoteFromHtml(noteId, token, source) {
    const url = new URL('/explore/' + noteId, location.origin);
    if (token) {
      url.searchParams.set('xsec_token', token);
      url.searchParams.set('xsec_source', source || 'pc_feed');
    }
    const res = await fetch(url.href, { credentials: 'include' });
    let finalPath = '';
    try {
      finalPath = new URL(res.url).pathname;
    } catch (_) {
      /* ignore */
    }
    if (/captcha|verify/i.test(finalPath)) throw new Error('小红书要求完成安全验证：请在页面上完成验证后再下载');
    if (/^\/login(?:\/|$)/i.test(finalPath)) throw new Error('需要登录小红书后才能查看这篇笔记（未登录时浏览几篇就会被限制）');
    if (/^\/404(?:\/|$)/.test(finalPath) || res.status === 404) throw new Error('这篇笔记已被删除，或暂时无法查看');
    if (!res.ok) throw new Error('获取笔记失败（HTTP ' + res.status + '）');
    const state = X.parseInitialState(await res.text());
    const map = state && state.note && state.note.noteDetailMap;
    if (!map || typeof map !== 'object') return null;
    const entry = map[noteId] || Object.values(map).find((e) => e && e.note && e.note.noteId === noteId);
    return entry && X.hasMedia(entry.note) ? entry.note : null;
  }

  // 读页面里已有的笔记数据；刚点开笔记时数据可能还是占位版本，可以等它加载完整
  async function pageNote(noteId, waitMs) {
    const deadline = Date.now() + (waitMs || 0);
    for (;;) {
      const r = await askPage('getNote', { noteId });
      if (!r || X.isCompleteNote(r.note) || Date.now() >= deadline) return r;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async function loadNote(ctx) {
    const fromPage = await pageNote(ctx.noteId, ctx.container ? 3000 : 0);
    const card = (fromPage && fromPage.card) || null;
    const inPage = fromPage && fromPage.note;
    if (X.isCompleteNote(inPage)) return { note: inPage, card };
    const token = ctx.token || (card && card.xsecToken) || (inPage && inPage.xsecToken) || '';
    let note = null;
    try {
      note = await fetchNoteFromHtml(ctx.noteId, token, ctx.source);
    } catch (e) {
      if (token) throw e;
    }
    // 没有 xsec_token 时小红书不给看笔记页面
    if (!note && !token) throw new Error('这里拿不到笔记的访问凭证：请先点开这篇笔记，再用详情里的按钮下载');
    return { note, card };
  }

  // 最后的兜底：直接读详情里轮播图的图片地址
  function noteFromDom(container, noteId) {
    const seen = new Set();
    const imageList = [];
    let imgs = container.querySelectorAll('.media-container .swiper-slide:not(.swiper-slide-duplicate) img');
    if (!imgs.length) imgs = container.querySelectorAll('.media-container img');
    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      const token = X.extractImageToken(src);
      if (!token || /avatar/i.test(src) || seen.has(token)) continue;
      seen.add(token);
      imageList.push({ urlDefault: src });
    }
    const titleEl = container.querySelector('#detail-title');
    const descEl = container.querySelector('#detail-desc');
    return {
      noteId,
      type: container.getAttribute('data-type') === 'video' ? 'video' : 'normal',
      title: titleEl ? titleEl.textContent.trim() : '',
      desc: descEl ? descEl.innerText : '',
      imageList,
    };
  }

  /* ------------------------------------------------------------------ 下载 */
  const jobs = new Map(); // noteId → { state: busy|done|warn|error, text }

  function setJob(noteId, state, text) {
    if (state === 'idle') jobs.delete(noteId);
    else jobs.set(noteId, { state, text });
    syncButtons(noteId);
  }

  function finishJob(noteId, state, text, ms) {
    setJob(noteId, state, text);
    setTimeout(() => {
      const job = jobs.get(noteId);
      if (job && job.state === state && job.text === text) setJob(noteId, 'idle');
    }, ms);
  }

  function runJob(job, onProgress) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'xhsdl-job' });
      } catch (_) {
        reject(new Error(RELOAD_HINT));
        return;
      }
      let finished = false;
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'progress') onProgress(msg);
        else if (msg.type === 'done') {
          finished = true;
          resolve(msg);
          try {
            port.disconnect();
          } catch (_) {
            /* ignore */
          }
        }
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (!finished) reject(new Error(extensionAlive() ? '后台下载任务意外中断，请重试' : RELOAD_HINT));
      });
      port.postMessage({ type: 'start', job });
    });
  }

  function progressText(p, plan) {
    if (plan.videoCount > 0) return p.percent + '%';
    return p.done + p.failed + '/' + p.total;
  }

  async function startDownload(ctx) {
    const noteId = ctx.noteId;
    if (!extensionAlive()) return toast(RELOAD_HINT, 'error');
    const running = jobs.get(noteId);
    if (running && running.state === 'busy') return toast('这篇笔记正在下载，请稍候…');

    setJob(noteId, 'busy', '解析中');
    try {
      const s = await loadSettings();
      let note = null;
      let card = null;
      let loadError = null;
      try {
        ({ note, card } = await loadNote(ctx));
      } catch (e) {
        loadError = e;
      }
      if (!X.hasMedia(note) && ctx.container) note = noteFromDom(ctx.container, noteId);
      if (!X.hasMedia(note)) throw loadError || new Error('没有拿到笔记内容：可能需要登录小红书，或先点开这篇笔记再下载');

      const plan = X.buildPlan(note, s, ctx.titleHint || (card && card.title));
      if (!plan.items.length) {
        throw new Error(plan.isVideo && !s.downloadVideo ? '这是视频笔记，已在设置中关闭视频下载，且没有找到封面' : '这篇笔记里没有找到可下载的图片');
      }

      setJob(noteId, 'busy', '0/' + plan.items.length);
      const result = await runJob(
        { noteId, folder: plan.folder, fallbackFolder: 'xiaohongshu_' + noteId, subDir: s.subDir, format: s.imageFormat, items: plan.items },
        (p) => setJob(noteId, 'busy', progressText(p, plan))
      );
      if (!result.done) throw new Error('下载失败：' + ((result.errors && result.errors[0]) || '未知错误'));

      // 至少存下了一个文件才点赞标记。点完再结束任务，免得点赞期间又被点一次下载、把赞取消掉
      const liked = await markDownloaded(noteId, !!ctx.container).catch((e) => {
        console.warn(LOG, e);
        return 'failed';
      });
      const likeTip = LIKE_SKIPPED[liked] ? '；' + LIKE_SKIPPED[liked] : '';
      const where = '「下载/' + result.dir + '」';
      if (result.failed) {
        finishJob(noteId, 'warn', result.done + '/' + result.total, 6000);
        toast(`已保存 ${result.done}/${result.total} 个文件到${where}，${result.failed} 个失败（${result.errors[0]}）${likeTip}`, 'warn', result.firstId);
      } else {
        const what = plan.videoCount ? ` ${result.done} 个文件` : ` ${result.done} 张图片`;
        finishJob(noteId, 'done', '已下载', 4000);
        toast(`已保存${what}到${where}${likeTip}`, 'success', result.firstId);
      }
    } catch (e) {
      console.warn(LOG, e);
      finishJob(noteId, 'error', '失败', 6000);
      toast((e && e.message) || String(e), 'error');
    }
  }

  /* ------------------------------------------------------------------ 按钮 */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    download: [['path', { d: 'M12 4.5v10M7.8 10.3 12 14.5l4.2-4.2M5 19.5h14' }]],
    busy: [['circle', { cx: '12', cy: '12', r: '8', 'stroke-dasharray': '34 60' }]],
    done: [['path', { d: 'M5 12.5 9.5 17 19 7.5' }]],
    error: [['path', { d: 'M12 6.5v7.5M12 18.2v.1' }]],
  };

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', name === 'busy' ? 'xhsdl-icon xhsdl-spin' : 'xhsdl-icon');
    for (const [tag, attrs] of ICONS[name] || ICONS.download) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
    }
    return svg;
  }

  function makeButton(variant) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xhsdl-btn xhsdl-btn--' + variant;
    btn.addEventListener('click', variant === 'card' ? onCardClick : onDetailClick);
    return btn;
  }

  // 按钮显示什么完全由 jobs 决定；同一篇笔记的卡片按钮和详情按钮会同步状态
  function render(btn) {
    const job = jobs.get(btn.dataset.noteId);
    const state = job ? job.state : 'idle';
    const text = job ? job.text : btn.dataset.idle || '下载';
    if (btn.dataset.state === state && btn.dataset.text === text) return;
    btn.dataset.state = state;
    btn.dataset.text = text;
    const iconName = state === 'busy' ? 'busy' : state === 'done' ? 'done' : state === 'idle' ? 'download' : 'error';
    let label = btn.querySelector('.xhsdl-label');
    if (!label || btn.dataset.icon !== iconName) {
      // 只在图标变化时重建，进度更新时只改文字（避免转圈动画每次重新开始）
      label = document.createElement('span');
      label.className = 'xhsdl-label';
      btn.replaceChildren(icon(iconName), label);
      btn.dataset.icon = iconName;
    }
    label.textContent = text;
    btn.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
  }

  function syncButtons(noteId) {
    for (const btn of document.querySelectorAll('.xhsdl-btn')) {
      if (btn.dataset.noteId === noteId) render(btn);
    }
  }

  /* ------------------------------------------------------------------ 笔记卡片 */
  function cardInfo(card) {
    let noteId = card.getAttribute('data-note-id') || '';
    let token = '';
    let source = '';
    for (const a of card.querySelectorAll('a[href]')) {
      const info = X.parseNoteUrl(a.getAttribute('href'), location.href);
      if (!info) continue;
      if (!noteId) noteId = info.noteId;
      if (info.noteId === noteId && info.xsecToken && !token) {
        token = info.xsecToken;
        source = info.xsecSource;
      }
    }
    if (!/^[0-9a-f]{24}$/i.test(noteId)) return null;
    const title = card.querySelector('.footer .title');
    return {
      noteId,
      token,
      source,
      titleHint: title ? title.textContent.trim() : '',
      isVideo: !!card.querySelector('.play-icon'),
    };
  }

  function injectCard(card) {
    let btn = card.querySelector('.xhsdl-btn--card');
    const attrId = card.getAttribute('data-note-id');
    if (btn && !btn.hidden && attrId && attrId === btn.dataset.noteId) {
      render(btn);
      return;
    }
    const info = cardInfo(card);
    if (!info) {
      if (btn) btn.hidden = true;
      return;
    }
    if (!btn) {
      btn = makeButton('card');
      // 放进卡片底部「作者 · 点赞」那一行，不改变卡片高度（瀑布流是按高度绝对定位的）
      const row = card.querySelector('.footer .author-wrapper, .footer .card-bottom-wrapper');
      if (row) {
        const like = Array.from(row.children).find((el) => el.classList.contains('like-wrapper'));
        row.insertBefore(btn, like || null);
      } else {
        btn.classList.add('xhsdl-btn--overlay');
        card.appendChild(btn);
      }
    }
    btn.hidden = false;
    const tip = info.isVideo ? '下载这篇视频笔记（视频和封面）' : '下载这篇笔记的全部图片';
    if (btn.title !== tip) btn.title = tip;
    btn.dataset.idle = '下载';
    btn.dataset.noteId = info.noteId;
    render(btn);
  }

  function onCardClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const card = event.currentTarget.closest('section.note-item');
    const info = card && cardInfo(card);
    if (!info) return toast('没找到这篇笔记的链接，刷新页面后再试', 'error');
    startDownload(info);
  }

  /* ------------------------------------------------------------------ 笔记详情 */
  // 详情按钮上显示的张数等信息。页面数据加载完整之前会隔一会儿再问一次（最多约 15 秒）
  const meta = new Map(); // noteId → { at, tries, complete, count, type, title, desc }

  function noteMeta(noteId) {
    if (!noteId) return null;
    const m = meta.get(noteId) || { at: 0, tries: 0, complete: false };
    if (!m.complete && m.tries < 20 && Date.now() - m.at > 700) {
      m.at = Date.now();
      m.tries++;
      meta.set(noteId, m);
      askPage('getNote', { noteId }).then((r) => {
        const n = r && r.note;
        if (n && X.hasMedia(n)) {
          Object.assign(m, { complete: X.isCompleteNote(n), count: n.imageList.length, type: n.type, title: n.title || '', desc: n.desc || '' });
          scheduleScan();
        }
        if (!m.complete && m.tries < 20) setTimeout(scheduleScan, 800);
      });
    }
    return m.count != null ? m : null;
  }

  // 详情里显示的是哪篇笔记：优先看地址栏，地址里没有笔记 ID 时用页面数据里的 currentNoteId
  function detailNoteId(container) {
    const fromUrl = X.parseNoteUrl(location.href);
    return (fromUrl && fromUrl.noteId) || container.dataset.xhsdlNoteId || '';
  }

  let askingCurrent = false;
  function rememberCurrentNoteId(container) {
    if (askingCurrent) return;
    askingCurrent = true;
    askPage('currentNoteId', {}).then((r) => {
      askingCurrent = false;
      if (r && r.noteId && container.isConnected && container.dataset.xhsdlNoteId !== r.noteId) {
        container.dataset.xhsdlNoteId = r.noteId;
        scheduleScan();
      }
    });
  }

  function countSlides(container) {
    const slides = container.querySelectorAll('.media-container .swiper-slide:not(.swiper-slide-duplicate)');
    if (slides.length) return slides.length;
    return container.querySelector('.media-container img') ? 1 : 0;
  }

  function injectDetail(container) {
    let bar = container.querySelector('.xhsdl-detail-bar');
    if (!bar) {
      const content = container.querySelector('.note-content');
      const scroller = container.querySelector('.note-scroller');
      if (!content && !scroller) return;
      bar = document.createElement('div');
      bar.className = 'xhsdl-detail-bar';
      const hint = document.createElement('div');
      hint.className = 'xhsdl-detail-hint';
      bar.append(makeButton('detail'), hint);
      // 放在笔记正文（标题、描述、标签、日期）的正下方
      if (content) content.appendChild(bar);
      else scroller.insertBefore(bar, scroller.children[1] || null);
    }

    const noteId = detailNoteId(container);
    if (!X.parseNoteUrl(location.href)) rememberCurrentNoteId(container);
    const m = noteMeta(noteId);

    const btn = bar.querySelector('.xhsdl-btn');
    const isVideo = (m && m.type === 'video') || container.getAttribute('data-type') === 'video';
    let idle;
    if (isVideo) {
      idle = settings.downloadVideo ? '下载视频和封面' : '下载视频封面';
    } else {
      // 页面数据完整时以它为准；否则取页面数据和轮播图里较大的那个数
      const n = m && m.complete ? m.count : Math.max((m && m.count) || 0, countSlides(container));
      idle = n ? `下载全部图片（${n} 张）` : '下载全部图片';
    }
    btn.dataset.idle = idle;
    btn.dataset.noteId = noteId;
    render(btn);

    const titleEl = container.querySelector('#detail-title');
    const title = (titleEl && titleEl.textContent.trim()) || (m && m.title) || '';
    // 没有标题的笔记用正文第一句命名，要等页面数据加载完才知道；在那之前先显示「…」，免得名字闪变
    const info = meta.get(noteId);
    const loading = !title && !!info && !info.complete && info.tries < 20;
    const folder = loading ? '…' : X.folderNameFor({ title, desc: m ? m.desc : '', noteId }, '');
    const sub = X.sanitizePath(settings.subDir);
    const hintText = '保存到：下载 / ' + (sub ? sub.split('/').join(' / ') + ' / ' : '') + folder + ' /';
    const hint = bar.querySelector('.xhsdl-detail-hint');
    if (hint && hint.textContent !== hintText) {
      hint.textContent = hintText;
      hint.title = hintText;
    }
  }

  async function onDetailClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const btn = event.currentTarget;
    const container = btn.closest('#noteContainer, .note-container');
    if (!container) return;
    const fromUrl = X.parseNoteUrl(location.href) || {};
    let noteId = fromUrl.noteId || btn.dataset.noteId;
    if (!noteId) {
      const r = await askPage('currentNoteId', {});
      noteId = r && r.noteId;
    }
    if (!noteId) return toast('没识别出当前打开的是哪篇笔记，刷新页面后再试', 'error');
    const titleEl = container.querySelector('#detail-title');
    startDownload({
      noteId,
      token: fromUrl.xsecToken || '',
      source: fromUrl.xsecSource || '',
      titleHint: titleEl ? titleEl.textContent.trim() : '',
      container,
    });
  }

  /* ------------------------------------------------------------------ 点赞标记 */
  // 下载完成后点一下这篇笔记的点赞按钮（红心），当作「已下载」的标记：
  //  - 点赞按钮是开关，已点赞的再点会取消，所以先看清状态，只在确定没点赞时点一次；
  //  - 卡片和打开的详情里可能同时有这篇笔记的点赞按钮，小红书会自己同步两边，只点其中一个；
  //  - 没登录时点赞会弹出登录框，这时不点。
  // 没点成的原因（会附在下载完成的提示后面）
  const LIKE_SKIPPED = {
    guest: '没登录小红书，没有自动点赞',
    missing: '没找到点赞按钮，没有自动点赞',
    unknown: '看不出是否已点过赞，没有自动点赞',
    failed: '自动点赞没有成功',
  };

  // 按钮图标显示的点赞状态，也就是点一下会切换掉的状态：true 已点赞 / false 没点赞 / null 认不出
  function likedInDom(btn) {
    if (!btn || !btn.isConnected) return null;
    if (btn.querySelector('.pray-like-icon')) return true; // 少数笔记点赞后图标换成一张图片
    const use = btn.querySelector('use');
    return use ? X.likeIconState(use.getAttribute('href') || use.getAttribute('xlink:href')) : null;
  }

  // 先看图标；图标认不出时再看页面数据
  async function isLiked(btn, noteId) {
    const dom = likedInDom(btn);
    if (dom !== null) return dom;
    const page = await askPage('likeInfo', { noteId });
    return page ? page.liked : null;
  }

  // 这篇笔记的点赞按钮：从详情里点的下载优先用详情的，否则优先用卡片的。
  // 详情的评论区里每条评论也有点赞按钮，只认底部互动栏（.engage-bar）里的那个
  function findLikeButton(noteId, preferDetail) {
    const inDetail = [];
    for (const container of document.querySelectorAll(DETAIL_CONTAINERS)) {
      const btn = detailNoteId(container) === noteId && container.querySelector('.engage-bar .like-wrapper');
      if (btn) inDetail.push(btn);
    }
    const inCards = [];
    for (const card of document.querySelectorAll('section.note-item')) {
      const info = cardInfo(card);
      const btn = info && info.noteId === noteId && card.querySelector('.footer .like-wrapper');
      if (btn) inCards.push(btn);
    }
    return (preferDetail ? inDetail.concat(inCards) : inCards.concat(inDetail))[0] || null;
  }

  // 返回 liked（点了赞）、already（本来就点过赞）、off（设置里关了），或 LIKE_SKIPPED 里没点成的原因
  async function markDownloaded(noteId, preferDetail) {
    if (!settings.likeAfterDownload) return 'off';
    const page = (await askPage('likeInfo', { noteId })) || {};
    if (page.loggedIn === false) return 'guest';
    const btn = findLikeButton(noteId, preferDetail);
    if (!btn) return page.liked === true ? 'already' : 'missing';
    const before = await isLiked(btn, noteId);
    if (before === true) return 'already';
    if (before !== false) return 'unknown';
    btn.click();
    // 卡片上的图标点下去马上变成已点赞；详情底部的要等点赞请求成功后才变。5 秒内还没变过来就是没点成
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleep(100);
      if ((await isLiked(btn, noteId)) === true) return 'liked';
    }
    return 'failed';
  }

  /* ------------------------------------------------------------------ 提示条 */
  let toastHost = null;

  function toast(message, type, downloadId) {
    type = type || 'info';
    if (!document.body) return;
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.className = 'xhsdl-toast-host';
      document.body.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.className = 'xhsdl-toast xhsdl-toast--' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.className = 'xhsdl-toast-text';
    text.textContent = message;
    el.appendChild(text);

    if (Number.isInteger(downloadId)) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'xhsdl-toast-action';
      open.textContent = '打开文件夹';
      open.addEventListener('click', () => {
        if (extensionAlive()) chrome.runtime.sendMessage({ type: 'show', id: downloadId }).catch(() => {});
      });
      el.appendChild(open);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'xhsdl-toast-close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    el.appendChild(close);

    let timer = 0;
    const dismiss = () => {
      clearTimeout(timer);
      el.classList.remove('xhsdl-toast--in');
      setTimeout(() => el.remove(), 250);
    };
    close.addEventListener('click', dismiss);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => {
      timer = setTimeout(dismiss, 2500);
    });

    toastHost.appendChild(el);
    while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
    requestAnimationFrame(() => el.classList.add('xhsdl-toast--in'));
    timer = setTimeout(dismiss, type === 'error' || type === 'warn' ? 8000 : 5000);
  }

  /* ------------------------------------------------------------------ 监听页面变化 */
  let scanTimer = 0;

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 150);
  }

  function scan() {
    if (!extensionAlive()) return;
    for (const card of document.querySelectorAll('section.note-item')) {
      try {
        injectCard(card);
      } catch (e) {
        console.debug(LOG, e);
      }
    }
    const containers = new Set(document.querySelectorAll(DETAIL_CONTAINERS));
    for (const container of containers) {
      try {
        injectDetail(container);
      } catch (e) {
        console.debug(LOG, e);
      }
    }
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', scheduleScan);
  loadSettings().then(scan);
})();
