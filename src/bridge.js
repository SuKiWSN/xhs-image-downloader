/*
 * 小红书图片下载 · 页面桥接脚本（运行在页面主环境 world: MAIN）
 *
 * 内容脚本运行在隔离环境里，读不到页面的 window.__INITIAL_STATE__。
 * 这个脚本只负责把页面里已有的笔记数据（图片列表、xsec_token 等）读出来，
 * 通过 CustomEvent + JSON 字符串交给内容脚本，省去一次网络请求。
 */
(() => {
  'use strict';
  if (window.__xhsdlBridgeReady) return;
  Object.defineProperty(window, '__xhsdlBridgeReady', { value: true });

  const REQUEST = 'xhsdl:request';
  const RESPONSE = 'xhsdl:response';

  // 页面状态里大量使用 Vue ref，真实值在 _rawValue / value 上
  const unref = (v) => {
    if (v && typeof v === 'object' && v.__v_isRef) return '_rawValue' in v ? v._rawValue : v.value;
    return v;
  };
  const getState = () => window.__INITIAL_STATE__ || null;

  // 只挑下载需要的字段，避免直接序列化响应式对象（里面有循环引用）
  function pickStream(stream) {
    const out = {};
    stream = unref(stream);
    if (!stream || typeof stream !== 'object') return out;
    for (const key of Object.keys(stream)) {
      const list = unref(stream[key]);
      if (!Array.isArray(list)) continue;
      out[key] = list.filter(Boolean).map((s) => ({
        masterUrl: s.masterUrl,
        backupUrls: Array.isArray(s.backupUrls) ? s.backupUrls.slice() : [],
        format: s.format,
        width: s.width,
        height: s.height,
        avgBitrate: s.avgBitrate,
        videoBitrate: s.videoBitrate,
        size: s.size,
      }));
    }
    return out;
  }

  function pickImage(img) {
    img = unref(img);
    if (!img || typeof img !== 'object') return null;
    const infoList = unref(img.infoList);
    return {
      fileId: img.fileId,
      traceId: img.traceId,
      url: img.url,
      urlDefault: img.urlDefault,
      urlPre: img.urlPre,
      infoList: Array.isArray(infoList) ? infoList.filter(Boolean).map((i) => ({ imageScene: i.imageScene, url: i.url })) : [],
      width: img.width,
      height: img.height,
      livePhoto: !!img.livePhoto,
      stream: pickStream(img.stream),
    };
  }

  function pickNote(note) {
    note = unref(note);
    if (!note || typeof note !== 'object') return null;
    const user = unref(note.user) || {};
    const video = unref(note.video);
    const media = video && unref(video.media);
    const consumer = video && unref(video.consumer);
    const images = unref(note.imageList);
    return {
      noteId: note.noteId,
      type: note.type,
      title: note.title,
      desc: note.desc,
      // 刚点开笔记时页面先用卡片信息放一个占位（只有封面、没有 time / desc），用这两个字段判断数据是否完整
      time: note.time,
      lastUpdateTime: note.lastUpdateTime,
      xsecToken: note.xsecToken,
      user: { nickname: user.nickname || user.nickName, userId: user.userId },
      imageList: Array.isArray(images) ? images.map(pickImage).filter(Boolean) : [],
      video: video
        ? {
            media: { stream: pickStream(media && media.stream) },
            consumer: consumer ? { originVideoKey: consumer.originVideoKey } : null,
          }
        : null,
    };
  }

  function getNote(noteId) {
    const s = getState();
    const map = s && s.note && unref(s.note.noteDetailMap);
    const entry = map && unref(map[noteId]);
    return entry ? pickNote(entry.note) : null;
  }

  // 在首页推荐、搜索结果、个人主页的列表里找卡片（主要为了拿 xsec_token）
  function* noteLists(s) {
    const feed = s.feed && unref(s.feed.feeds);
    if (Array.isArray(feed)) yield feed;
    const search = s.search && unref(s.search.feeds);
    if (Array.isArray(search)) yield search;
    const userNotes = s.user && unref(s.user.notes);
    if (Array.isArray(userNotes)) {
      for (const tab of userNotes) {
        const list = unref(tab);
        if (Array.isArray(list)) yield list;
      }
    }
  }

  function findCard(noteId) {
    const s = getState();
    if (!s) return null;
    for (const list of noteLists(s)) {
      for (const raw of list) {
        const item = unref(raw);
        if (!item || typeof item !== 'object') continue;
        const card = unref(item.noteCard) || {};
        const id = item.id || item.noteId || card.noteId;
        if (id === noteId) {
          return {
            xsecToken: item.xsecToken || card.xsecToken || '',
            title: card.displayTitle || card.title || '',
            type: card.type || '',
          };
        }
      }
    }
    return null;
  }

  function currentNoteId() {
    const s = getState();
    if (!s || !s.note) return null;
    return unref(s.note.currentNoteId) || unref(s.note.firstNoteId) || null;
  }

  window.addEventListener(REQUEST, (event) => {
    if (typeof event.detail !== 'string') return;
    let req;
    try {
      req = JSON.parse(event.detail);
    } catch (_) {
      return;
    }
    if (!req || typeof req.id !== 'string') return;
    let result = null;
    let error = null;
    try {
      if (req.action === 'getNote' && typeof req.noteId === 'string') {
        result = { note: getNote(req.noteId), card: findCard(req.noteId) };
      } else if (req.action === 'currentNoteId') {
        result = { noteId: currentNoteId() };
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
    let detail;
    try {
      detail = JSON.stringify({ id: req.id, result, error });
    } catch (e) {
      detail = JSON.stringify({ id: req.id, result: null, error: 'serialize failed' });
    }
    window.dispatchEvent(new CustomEvent(RESPONSE, { detail }));
  });
})();
