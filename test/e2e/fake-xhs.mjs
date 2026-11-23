// 本地「假」小红书：笔记页面 + 图片 / 视频 CDN，全部跑在 127.0.0.1 上的一个 HTTPS 服务里。
// 测试时浏览器用 --host-resolver-rules 把 www.xiaohongshu.com、*.xhscdn.com 指到这里，
// 这样不用登录、不依赖外网，在 Windows / macOS / Linux 上都能稳定地跑完整的下载流程。
// 页面结构和数据格式照着真实的小红书网页做（只保留插件用到的部分）。
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name));
const box = (type, ...brands) => Buffer.concat([Buffer.from([0, 0, 0, 8 + 4 * (brands.length + 2)]), Buffer.from('ftyp' + type), Buffer.alloc(4), Buffer.from(brands.join(''))]);

// 服务器返回的文件；测试按字节比较下载结果
export const FILES = {
  photoJpg: fixture('photo.jpg'),
  photoPng: fixture('photo.png'),
  coverJpg: fixture('cover.jpg'),
  convertedJpg: fixture('converted.jpg'), // CDN 把原图转成 JPG 的结果
  convertedPng: fixture('converted.png'), // CDN 把原图转成 PNG 的结果
  previewWebp: fixture('preview.webp'), // 网页里显示的预览图
  heic: Buffer.concat([box('heic', 'mif1', 'heic'), Buffer.alloc(2048, 1)]), // 苹果 HEIC 原图（只需要文件头对）
  mp4: Buffer.concat([box('isom', 'isom', 'iso2', 'avc1', 'mp41'), Buffer.alloc(64 * 1024, 7)]),
};

const noteId = (n) => '6a1e2e' + String(n).padStart(18, '0');
const tokenOf = (id) => 'e2eToken' + id.slice(-4) + '=';
const imageToken = (id, i, kind) => `notes_pre_post/e2e_${id.slice(-4)}_${i}_${kind}`;
const webpicUrl = (token, suffix) => `http://sns-webpic-qc.xhscdn.com/202611230000/0123456789abcdef0123456789abcdef/${token}!${suffix}`;

// kinds：原图的真实格式。missing = 原图服务器上没有，只能退回网页预览图
// liked：测试开始前就已经点过赞
function makeNote(n, { type = 'normal', title = '', desc = '', kinds = [], card = {}, liked = false }) {
  const id = noteId(n);
  const imageList = kinds.map((kind, i) => {
    const token = imageToken(id, i + 1, kind);
    return {
      fileId: token,
      traceId: '',
      urlPre: webpicUrl(token, 'nc_n_webp_prv_1'),
      urlDefault: webpicUrl(token, 'nd_dft_wlteh_webp_3'),
      infoList: [
        { imageScene: 'WB_PRV', url: webpicUrl(token, 'nc_n_webp_prv_1') },
        { imageScene: 'WB_DFT', url: webpicUrl(token, 'nd_dft_wlteh_webp_3') },
      ],
      width: 1080,
      height: 1440,
      livePhoto: false,
      stream: {},
    };
  });
  const note = {
    noteId: id,
    type,
    title,
    desc,
    time: 1795400000000 + n,
    lastUpdateTime: 1795400000000 + n,
    ipLocation: '上海',
    xsecToken: tokenOf(id),
    user: { userId: '5f00000000000000000e2e01', nickname: '测试作者' },
    interactInfo: { likedCount: String(10 + n) },
    imageList,
    tagList: [],
  };
  if (type === 'video') {
    note.video = {
      media: {
        stream: {
          h265: [],
          h264: [{ format: 'mp4', width: 720, height: 1280, avgBitrate: 1200000, masterUrl: `http://sns-video-hw.xhscdn.com/stream/1/110/259/e2e_${id}_259.mp4`, backupUrls: [] }],
        },
      },
      consumer: { originVideoKey: `pre_post/e2e_${id}` },
    };
  }
  return { id, token: tokenOf(id), note, liked, card: { dataNoteId: true, ...card } };
}

// 测试用的笔记；expect 是插件应该存下来的文件（相对下载目录）
export const NOTES = {
  images: makeNote(1, {
    title: 'A/B:C*D?"E<F>G|H~ 测试😀.',
    desc: '四张图：jpg 原图、png 原图、heic 原图、原图缺失',
    kinds: ['jpg', 'png', 'heic', 'missing'],
  }),
  video: makeNote(2, { type: 'video', title: '视频笔记 测试', desc: '视频', kinds: ['cover'], card: { dataNoteId: false }, liked: true }),
  untitled: makeNote(3, { title: '', desc: '#好物分享[话题]# 第一句话: 正文开头[笑哭R]\n第二句', kinds: ['jpg', 'png'] }),
  reserved: makeNote(4, { title: 'CON', desc: 'Windows 保留名', kinds: ['jpg'] }),
  // 截断后正好是文件夹名的长度上限（60 个字符）
  longTitle: makeNote(5, { title: 'Windows 长路径测试 long path test ' + 'abcdefghij'.repeat(8) + ' 很长的标题😀', desc: '', kinds: ['jpg', 'png'] }),
};
NOTES.images.expect = { folder: 'A／B：C＊D？＂E＜F＞G｜H～ 测试😀', files: { '01.jpg': 'photoJpg', '02.png': 'photoPng', '03.jpg': 'convertedJpg', '04.webp': 'previewWebp' } };
NOTES.video.expect = { folder: '视频笔记 测试', files: { '封面.jpg': 'coverJpg', '视频.mp4': 'mp4' } };
NOTES.untitled.expect = { folder: '第一句话： 正文开头', files: { '01.jpg': 'photoJpg', '02.png': 'photoPng' } };
NOTES.reserved.expect = { folder: '_CON', files: { '01.jpg': 'photoJpg' } };

export function noteUrl(entry, base = 'https://www.xiaohongshu.com') {
  return `${base}/explore/${entry.id}?xsec_token=${encodeURIComponent(entry.token)}&xsec_source=pc_feed`;
}

// 测试里的笔记评论（详情的评论区里每条评论也有自己的点赞按钮，插件不能点到它）
export const COMMENT_ID = '6a1e2e0000000000000c0001';

/* ------------------------------------------------------------------ HTML */
// 页面数据里的图片地址是 http://（和真实网站一样），页面上显示时用 https://
const secure = (url) => url.replace(/^http:/, 'https:');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 和真实页面一样：数据是 JS 字面量（含 undefined），放在 <script>window.__INITIAL_STATE__=…</script> 里
function stateScript(state) {
  const json = JSON.stringify(state).replace(/</g, '\\u003c');
  return `<script>window.__INITIAL_STATE__=${json.slice(0, -1)},"global":undefined}</script>`;
}

const ref = (value) => ({ __v_isRef: true, __v_isShallow: false, _rawValue: value, _value: value, dep: {} });

// 和真实页面一样：user.loggedIn 是否已登录，没登录时 userInfo.guest 为 true
const userState = (guest) => ({ loggedIn: ref(!guest), userInfo: ref({ userId: guest ? '' : '5f00000000000000000e2e99', guest }) });

// 页面数据里的点赞状态。哪些笔记已点赞记在服务器上（和真实网站一样，刷新页面后还在）；没登录时一律是没点赞
function interactInfo(entry, site, guest) {
  const liked = !guest && site.liked.has(entry.id);
  return { liked, likedCount: String(Number(entry.note.interactInfo.likedCount) + (liked ? 1 : 0)) };
}

// 点赞按钮，结构照真实页面的 Like 组件：图标没点赞时是 #like_b，已点赞是 #liked。
// data-e2e-like 标明按钮属于哪篇笔记 / 哪条评论，只给下面的 LIKE_SCRIPT 用
function likeButton(target, liked, count, size = 16) {
  const icon = liked ? '#liked' : '#like_b';
  return (
    `<span class="like-wrapper like-active" data-e2e-like="${target}">` +
    `<span class="like-lottie" style="width: ${size}px; height: ${size}px;"></span>` +
    `<svg class="reds-icon like-icon" width="${size}" height="${size}"><use href="${icon}" xlink:href="${icon}"></use></svg>` +
    `<span class="count" selected-disabled-search="">${count}</span></span>`
  );
}

// 真实页面把图标放在 body 开头的 SVG sprite 里
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="position: absolute; width: 0; height: 0; overflow: hidden" aria-hidden="true">
<symbol id="like_b" viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.4 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" fill="none" stroke="currentColor" stroke-width="1.8"/></symbol>
<symbol id="liked" viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.2 4.2 0 0 1 12 7.4 4.2 4.2 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" fill="#ff2442"/></symbol>
</svg>`;

// 照真实网站 Like 组件的点击逻辑：
//  - 没登录：什么都不改，弹出登录框；
//  - 已登录：在「点赞 / 取消点赞」之间切换，请求点赞或取消点赞的接口。
//    卡片上的按钮点了马上换图标和数字；详情底部的按钮要等接口返回成功后才换（真实网站就是这样）。
const LIKE_SCRIPT = `<script>
(() => {
  const unref = (v) => (v && v.__v_isRef ? v._rawValue : v);
  const state = window.__INITIAL_STATE__;
  // 页面数据里这篇笔记的 interactInfo（列表里的卡片、详情）
  function infosOf(noteId) {
    const out = [];
    for (const f of unref(state.feed && state.feed.feeds) || []) if (f.id === noteId) out.push(f.noteCard.interactInfo);
    const entry = state.note && state.note.noteDetailMap[noteId];
    if (entry) out.push(entry.note.interactInfo);
    return out;
  }
  function onClick(event) {
    const btn = event.currentTarget;
    if (!unref(state.user.loggedIn)) {
      const modal = document.createElement('div');
      modal.className = 'login-modal';
      modal.textContent = '登录后才能点赞';
      document.body.appendChild(modal);
      return;
    }
    const [kind, id] = btn.dataset.e2eLike.split(':');
    const use = btn.querySelector('use');
    const liked = use.getAttribute('href') !== '#liked';
    const show = () => {
      const icon = liked ? '#liked' : '#like_b';
      use.setAttribute('href', icon);
      use.setAttribute('xlink:href', icon);
      const count = btn.querySelector('.count');
      count.textContent = String(Number(count.textContent) + (liked ? 1 : -1));
      if (kind === 'note') for (const info of infosOf(id)) Object.assign(info, { liked, likedCount: count.textContent });
    };
    const request = fetch('/api/sns/web/v1/' + kind + '/' + (liked ? 'like' : 'dislike'), {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(kind === 'note' ? { note_oid: id } : { comment_id: id }),
    });
    if (btn.closest('.engage-bar')) request.then((res) => res.ok && show());
    else show();
  }
  for (const btn of document.querySelectorAll('.like-wrapper')) btn.addEventListener('click', onClick);
})();
</script>`;

function page(title, body, state) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="xhsdl-e2e" content="fake-xhs">
<title>${esc(title)} - 小红书</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .feeds-container { display: grid; grid-template-columns: repeat(4, 240px); gap: 16px; padding: 16px; }
  .note-item .cover { display: block; position: relative; height: 200px; background: #eee; }
  .note-item .cover img { width: 100%; height: 100%; object-fit: cover; }
  .footer { padding: 8px; }
  .footer .title { display: block; margin-bottom: 6px; color: #333; text-decoration: none; }
  .card-bottom-wrapper { display: flex; align-items: center; height: 20px; }
  .author { flex: 1; min-width: 0; color: #666; }
  .play-icon { position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; background: #0006; border-radius: 50%; }
  #noteContainer { display: flex; width: 1000px; margin: 20px auto; border: 1px solid #eee; }
  .media-container { width: 560px; height: 600px; background: #f5f5f5; overflow: hidden; }
  .media-container img { width: 100%; }
  .interaction-container { flex: 1; padding: 16px; }
  .like-wrapper { display: inline-flex; align-items: center; gap: 2px; color: #666; cursor: pointer; }
  .like-lottie { display: none; }
  .comment-item { padding: 8px 0; border-top: 1px solid #eee; }
  .engage-bar-container { padding-top: 12px; border-top: 1px solid #eee; }
  .login-modal { position: fixed; inset: 0; display: grid; place-items: center; background: #0008; color: #fff; font-size: 20px; }
</style>
</head>
<body>
${SPRITE}
<div id="app">${body}</div>
${state ? stateScript(state) + '\n' + LIKE_SCRIPT : ''}
</body>
</html>`;
}

function feedPage(site, guest) {
  const entries = Object.values(NOTES);
  const infos = entries.map((e) => interactInfo(e, site, guest));
  const cards = entries
    .map((e, i) => {
      const href = `/explore/${e.id}?xsec_token=${encodeURIComponent(e.token)}&amp;xsec_source=pc_feed`;
      const cover = secure(webpicUrl(e.note.imageList[0].fileId, 'nc_n_webp_mw_1'));
      return `
  <section class="note-item" data-index="${i}"${e.card.dataNoteId ? ` data-note-id="${e.id}"` : ''} data-width="1080" data-height="1440">
    <div>
      <a href="/explore/${e.id}" style="display:none"></a>
      <a class="cover mask ld" target="_self" href="${href}">
        <img src="${cover}" alt="">${e.note.type === 'video' ? '<span class="play-icon"></span>' : ''}
      </a>
      <div class="footer">
        <a class="title" href="${href}"><span>${esc(e.note.title || e.note.desc.slice(0, 12))}</span></a>
        <div class="card-bottom-wrapper">
          <a class="author" href="/user/profile/${e.note.user.userId}"><span class="name">${esc(e.note.user.nickname)}</span></a>
          ${likeButton('note:' + e.id, infos[i].liked, infos[i].likedCount)}
        </div>
      </div>
    </div>
  </section>`;
    })
    .join('');
  const state = {
    user: userState(guest),
    feed: {
      feeds: ref(
        entries.map((e, i) => ({
          id: e.id,
          modelType: 'note',
          xsecToken: e.token,
          noteCard: { type: e.note.type, displayTitle: e.note.title, user: e.note.user, interactInfo: infos[i] },
        }))
      ),
    },
    note: { noteDetailMap: {}, currentNoteId: ref('') },
  };
  return page('发现', `<div class="feeds-container">${cards}</div>`, state);
}

function detailPage(entry, site, guest) {
  const info = interactInfo(entry, site, guest);
  const n = { ...entry.note, interactInfo: info };
  const slides = n.imageList.map((img) => `<div class="swiper-slide"><img src="${secure(img.urlDefault)}" alt=""></div>`).join('');
  // 评论区在互动栏前面，每条评论都有点赞按钮：插件只能点底部互动栏里笔记的那个
  const comments = `
      <div class="comments-el"><div class="comments-container"><div class="list-container"><div class="parent-comment">
        <div id="comment-${COMMENT_ID}" class="comment-item"><div class="comment-inner-container"><div class="right">
          <div class="content"><span class="note-text">评论区的第一条评论</span></div>
          <div class="info"><div class="interactions"><div class="like">${likeButton('comment:' + COMMENT_ID, false, 3)}</div></div></div>
        </div></div></div>
      </div></div></div></div>`;
  const engageBar = `
    <div class="interactions engage-bar"><div class="engage-bar-container"><div class="engage-bar"><div class="input-box"><div class="interact-container">
      <div class="buttons engage-bar-style"><div class="left">${likeButton('note:' + n.noteId, info.liked, info.likedCount, 24)}</div></div>
    </div></div></div></div></div>`;
  const body = `
<div id="noteContainer" class="note-container" data-type="${n.type}">
  <div class="media-container"><div class="swiper"><div class="swiper-wrapper">${slides}</div></div></div>
  <div class="interaction-container">
    <div class="author-container"><span class="username">${esc(n.user.nickname)}</span></div>
    <div class="note-scroller">
      <div class="note-content">
        <div id="detail-title" class="title">${esc(n.title)}</div>
        <div id="detail-desc" class="desc"><span class="note-text">${esc(n.desc)}</span></div>
        <div class="bottom-container"><span class="date">11-23 ${esc(n.ipLocation)}</span></div>
      </div>${comments}
    </div>${engageBar}
  </div>
</div>`;
  const state = {
    user: userState(guest),
    note: { currentNoteId: ref(n.noteId), firstNoteId: ref(n.noteId), noteDetailMap: { [n.noteId]: { note: n, comments: { list: [] } } } },
  };
  return page(n.title || n.desc.slice(0, 12), body, state);
}

/* ------------------------------------------------------------------ 服务器 */
function send(req, res, status, type, body) {
  const headers = { 'content-type': type, 'cache-control': 'no-store' };
  let payload = typeof body === 'string' ? Buffer.from(body) : body;
  // 和 CDN 一样支持 Range（插件先只读 64 字节文件头来判断格式）
  const m = payload && status === 200 && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : payload.length - 1, payload.length - 1);
    headers['content-range'] = `bytes ${start}-${end}/${payload.length}`;
    payload = payload.subarray(start, end + 1);
    status = 206;
  }
  headers['content-length'] = payload ? payload.length : 0;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

// 点赞 / 取消点赞接口：记下收到的请求，更新服务器上的点赞状态
function handleLike(req, res, site, kind, action) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
      /* 记成空 ID，测试会发现 */
    }
    const id = String((kind === 'note' ? body.note_oid : body.comment_id) || '');
    site.likeLog.push({ kind, action, id });
    if (kind === 'note') site.liked[action === 'like' ? 'add' : 'delete'](id);
    // 模拟网络延迟：详情底部的点赞按钮要等接口返回才换图标，插件得等得住
    setTimeout(() => send(req, res, 200, 'application/json; charset=utf-8', JSON.stringify({ code: 0, success: true, msg: '成功', data: {} })), 600);
  });
}

function handleSite(req, res, url, site) {
  const like = /^\/api\/sns\/web\/v1\/(note|comment)\/(like|dislike)$/.exec(url.pathname);
  if (like && req.method === 'POST') return handleLike(req, res, site, like[1], like[2]);
  // 地址带 guest=1 时按没登录的样子显示页面
  const guest = url.searchParams.get('guest') === '1';
  if (url.pathname === '/' || url.pathname === '/explore') return send(req, res, 200, 'text/html; charset=utf-8', feedPage(site, guest));
  const m = /^\/explore\/([0-9a-f]{24})$/.exec(url.pathname);
  if (m) {
    const entry = Object.values(NOTES).find((e) => e.id === m[1]);
    // 和真实网站一样：没有正确的 xsec_token 就跳到 404 页
    if (!entry || url.searchParams.get('xsec_token') !== entry.token) {
      res.writeHead(302, { location: '/404?source=note&noteId=' + m[1] });
      return res.end();
    }
    return send(req, res, 200, 'text/html; charset=utf-8', detailPage(entry, site, guest));
  }
  if (url.pathname === '/404') return send(req, res, 200, 'text/html; charset=utf-8', page('404', '<p>当前笔记暂时无法浏览</p>'));
  return send(req, res, 404, 'text/plain', 'not found');
}

// 原图服务器：sns-img-bd.xhscdn.com/<图片 ID>，带 imageView2 参数时按要求转格式
function handleOrigin(req, res, url) {
  const token = decodeURIComponent(url.pathname.slice(1));
  const kind = (/_(jpg|png|heic|cover|missing)$/.exec(token) || [])[1];
  if (!kind || kind === 'missing') return send(req, res, 404, 'text/html', '<h1>404</h1>');
  if (url.search === '?imageView2/format/jpg/q/95') return send(req, res, 200, 'image/jpeg', FILES.convertedJpg);
  if (url.search === '?imageView2/format/png') return send(req, res, 200, 'image/png', FILES.convertedPng);
  if (url.search) return send(req, res, 400, 'text/plain', 'bad query');
  const file = { jpg: FILES.photoJpg, png: FILES.photoPng, heic: FILES.heic, cover: FILES.coverJpg }[kind];
  return send(req, res, 200, 'application/octet-stream', file); // 真实 CDN 也常返回 octet-stream
}

export async function startFakeXhs() {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'www.xiaohongshu.com' }], { keyType: 'ec', algorithm: 'sha256' });
  const requests = [];
  // liked：服务器上已点赞的笔记；likeLog：收到的点赞 / 取消点赞请求，测试按它检查插件点了什么
  const site = { liked: new Set(Object.values(NOTES).filter((e) => e.liked).map((e) => e.id)), likeLog: [] };
  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    let url;
    try {
      url = new URL(req.url, 'https://' + host);
    } catch (_) {
      return send(req, res, 400, 'text/plain', 'bad url');
    }
    requests.push({ host, path: url.pathname + url.search, range: req.headers.range || '' });
    if (host === 'www.xiaohongshu.com') return handleSite(req, res, url, site);
    if (host === 'sns-img-bd.xhscdn.com' || host === 'ci.xiaohongshu.com') return handleOrigin(req, res, url);
    if (host === 'sns-webpic-qc.xhscdn.com') return send(req, res, 200, 'image/webp', FILES.previewWebp);
    if (/^sns-video-[a-z0-9]+\.xhscdn\.com$/.test(host)) return send(req, res, 200, 'video/mp4', FILES.mp4);
    return send(req, res, 404, 'text/plain', 'unknown host ' + host);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    likeLog: site.likeLog,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
