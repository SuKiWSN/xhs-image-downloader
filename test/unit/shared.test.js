// 公共工具的单元测试：node --test test/unit/shared.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const X = require('../../src/shared.js');

const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const graphemes = (s) => Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(s), (g) => g.segment);

// Chromium net::IsSafePortablePathComponent 的规则（chrome.downloads 在所有系统上都按它检查文件名）
function chromeLegal(name) {
  if (!name) return false;
  if (/["~*/:<>?\\|]/.test(name)) return false;
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}]/u.test(name)) return false;
  if (/^[\p{White_Space}.]|[\p{White_Space}.]$/u.test(name)) return false;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i.test(name) || /^(desktop\.ini|thumbs\.db)$/i.test(name)) return false;
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (['lnk', 'local', 'scf'].includes(ext) || /^\{.*\}$/.test(ext)) return false;
  }
  return true;
}

// 各系统真正的文件名限制
function fitsEverywhere(name, { maxUnits, maxBytes }) {
  return name.length <= maxUnits && utf8(name) <= maxBytes && utf8(name) <= 143; // 143：Linux eCryptfs
}

test('真实标题：去掉表情里的零宽连接符', () => {
  const s = X.sanitizeSegment('梁淅沥，你的当务之急是换掉发型💇‍♀️');
  assert(!s.includes('\u200d'));
  assert(s.startsWith('梁淅沥，你的当务之急是换掉发型💇'));
  assert(chromeLegal(s), s);
});

test('非法符号换成全角', () => {
  const s = X.sanitizeSegment('a/b\\c:d*e?f"g<h>i|j~k');
  assert.equal(s, 'a／b＼c：d＊e？f＂g＜h＞i｜j～k');
  assert(chromeLegal(s));
});

test('去掉首尾的点和空白，合并换行', () => {
  assert.equal(X.sanitizeSegment('  ..hello\n\n world..  '), 'hello world');
  assert.equal(X.sanitizeSegment('　标题　'), '标题');
  assert.equal(X.sanitizeSegment('...'), '');
  assert.equal(X.sanitizeSegment(''), '');
  assert.equal(X.sanitizeSegment(null), '');
});

test('Windows 保留名和危险扩展名', () => {
  assert.equal(X.sanitizeSegment('CON'), '_CON');
  assert.equal(X.sanitizeSegment('con.txt'), '_con.txt');
  assert.equal(X.sanitizeSegment('nul .tar.gz'), '_nul .tar.gz');
  assert.equal(X.sanitizeSegment('COM0'), '_COM0');
  assert.equal(X.sanitizeSegment('lpt¹'), '_lpt¹');
  assert.equal(X.sanitizeSegment('CONIN$'), '_CONIN$');
  assert.equal(X.sanitizeSegment('Desktop.ini'), '_Desktop.ini');
  assert.equal(X.sanitizeSegment('console'), 'console');
  assert.equal(X.sanitizeSegment('con 测试'), 'con 测试');
  assert.equal(X.sanitizeSegment('好物.lnk'), '好物.lnk_');
  assert(chromeLegal(X.sanitizeSegment('a.{0AFACED1-E828-11D1-9187-B532F1E9575D}')));
});

test('文件夹名长度：Windows 路径和 Linux 字节数都不超限', () => {
  const cjk = X.sanitizeSegment('测'.repeat(100));
  assert.equal(cjk.length, 46); // 46 个汉字 = 138 字节
  assert(fitsEverywhere(cjk, X.LIMITS.folder));
  const ascii = X.sanitizeSegment('a'.repeat(100));
  assert.equal(ascii.length, X.LIMITS.folder.maxUnits);
  const emoji = X.sanitizeSegment('😀'.repeat(80));
  assert(fitsEverywhere(emoji, X.LIMITS.folder) && chromeLegal(emoji));
  const flags = X.sanitizeSegment('🇨🇳'.repeat(40));
  assert.equal(graphemes(flags).join(''), flags);
  assert(graphemes(flags).every((g) => g === '🇨🇳'), '国旗不能被切开');
  // 补「_」之后仍然不超限
  const reserved = X.sanitizeSegment('CON.' + 'a'.repeat(100));
  assert(reserved.startsWith('_CON.') && reserved.length <= X.LIMITS.folder.maxUnits);
});

test('随机字符串：结果要么为空，要么在所有系统上合法', () => {
  const pool = ['a', '.', ' ', '\u200d', '\u200b', '\ufeff', '/', ':', '~', '\n', '\t', '测', '😀', '\ud800', '\ufffe', '\u0085', '\u00a0', '\u3000', '\ufdd0', 'C', 'O', 'N', '1', '¹', 'é', '\u0301', '👨‍👩‍👧‍👦'];
  for (let i = 0; i < 20000; i++) {
    let s = '';
    const len = Math.floor(Math.random() * 40);
    for (let j = 0; j < len; j++) s += pool[Math.floor(Math.random() * pool.length)];
    const out = X.sanitizeSegment(s);
    if (out) {
      assert(chromeLegal(out), JSON.stringify(s) + ' -> ' + JSON.stringify(out));
      assert(fitsEverywhere(out, X.LIMITS.folder), JSON.stringify(out));
    }
  }
});

test('上级文件夹：多级、去掉盘符和 ~、总长度受限', () => {
  assert.equal(X.sanitizePath('小红书/收藏'), '小红书/收藏');
  assert.equal(X.sanitizePath('小红书\\收藏'), '小红书/收藏');
  assert.equal(X.sanitizePath('/../a//b\\c/'), 'a/b/c');
  assert.equal(X.sanitizePath('D:\\图片\\小红书'), '图片/小红书');
  assert.equal(X.sanitizePath('C:'), '');
  assert.equal(X.sanitizePath('~/Pictures/xhs'), 'Pictures/xhs');
  assert.equal(X.sanitizePath('\\\\server\\share\\x'), 'server/share/x');
  assert.equal(X.sanitizePath('a/b/c/d/e/f/g'), 'a/b/c/d/e');
  assert.equal(X.sanitizePath(''), '');
  const long = X.sanitizePath(Array.from({ length: 5 }, (_, i) => String(i).repeat(30)).join('/'));
  assert(long.length <= X.LIMITS.subDirUnits, long);
  assert.equal(long, '0'.repeat(30));
  for (const seg of X.sanitizePath('收藏'.repeat(40) + '/' + 'x'.repeat(10)).split('/')) {
    assert(fitsEverywhere(seg, X.LIMITS.subDirSegment) && chromeLegal(seg), seg);
  }
});

test('Windows 最长路径：下载目录 115 个字符以内都不超过 259 个字符', () => {
  const subDir = X.sanitizePath('收藏'.repeat(20) + '/' + '旅行'.repeat(20) + '/' + 'x'.repeat(30));
  const folder = X.folderNameFor({ title: '😀a'.repeat(50) });
  const relDir = subDir + '/' + folder;
  const fileName = '01_实况 (99).mp4'; // 最长的文件名（含重名时 Chrome 加的序号）
  const downloadDir = 'C:\\' + 'd'.repeat(112); // 115 个字符
  assert(downloadDir.length + 1 + relDir.length <= 247, '文件夹路径 ≤ 247');
  assert(downloadDir.length + 1 + relDir.length + 1 + fileName.length + '.crdownload'.length <= 259, '文件路径 ≤ 259');
  // 备用文件夹更短
  assert.equal(X.sanitizeSegment('xiaohongshu_6ad1782d00000000180131cb'), 'xiaohongshu_6ad1782d00000000180131cb');
});

test('绝对路径识别', () => {
  for (const p of ['C:\\Users\\a', 'd:/图片', '\\\\nas\\photo', '~/Pictures', '~', '/Users/a/Downloads', '/home/a', '/mnt/c']) assert(X.looksLikeAbsolutePath(p), p);
  for (const p of ['小红书', '小红书/收藏', '/小红书', '', 'a:b']) assert(!X.looksLikeAbsolutePath(p), p);
});

test('文件夹命名的优先级', () => {
  assert.equal(X.folderNameFor({ title: '标题' }), '标题');
  assert.equal(X.folderNameFor({ title: '', desc: '\n第一句话[笑哭R] #好物分享[话题]#\n第二句' }), '第一句话');
  assert.equal(X.folderNameFor({ title: '', desc: '' }, '卡片标题'), '卡片标题');
  assert.equal(X.folderNameFor({ title: '', desc: '正文第一句\n第二句' }, '卡片显示的标题'), '正文第一句');
  assert.equal(X.folderNameFor({ title: '真正的标题', desc: '正文' }, '卡片显示的标题'), '真正的标题');
  assert.equal(X.folderNameFor({ title: '', desc: '', noteId: '6ad1782d00000000180131cb' }), '小红书笔记_6ad1782d00000000180131cb');
});

test('从图片地址提取图片 ID', () => {
  assert.equal(
    X.extractImageToken('http://sns-webpic-qc.xhscdn.com/202611230041/6ac4fa9023ec4401178e89cee486e8ed/notes_pre_post/1040g3k8326c81jpul0905q9fs7sdp7sb2intfpo!nd_dft_wlteh_webp_3'),
    'notes_pre_post/1040g3k8326c81jpul0905q9fs7sdp7sb2intfpo'
  );
  assert.equal(
    X.extractImageToken('https://sns-webpic-qc.xhscdn.com/202611230044/b243fe26346165bdcdb66a1e0cc0c761/oss-sg/notes_pre_post/1040g3mo326idkoe5jk5g5oqi8i765mtspci1508!nd_dft_wlteh_jpg_3'),
    'oss-sg/notes_pre_post/1040g3mo326idkoe5jk5g5oqi8i765mtspci1508'
  );
  assert.equal(
    X.extractImageToken('http://sns-webpic-qc.xhscdn.com/202611230044/596ab51ede89794636e149ee82bf447c/1040g008325ss8a99kq005o1b517g8l6jjspfgao!nd_dft_wlteh_jpg_3'),
    '1040g008325ss8a99kq005o1b517g8l6jjspfgao'
  );
  assert.equal(X.extractImageToken('https://sns-img-bd.xhscdn.com/1040g008325ss8a99kq005o1b517g8l6jjspfgao'), '1040g008325ss8a99kq005o1b517g8l6jjspfgao');
  assert.equal(X.extractImageToken('https://evil.example.com/202611230041/6ac4fa9023ec4401178e89cee486e8ed/x'), '');
  assert.equal(X.extractImageToken('blob:https://www.xiaohongshu.com/abc'), '');
});

test('图片候选地址：原图优先', () => {
  const img = {
    fileId: 'oss-sg/notes_pre_post/1040g3mo326idkoe5jk5g5oqi8i765mtspci1508',
    urlDefault: 'http://sns-webpic-qc.xhscdn.com/202611230044/b243fe26346165bdcdb66a1e0cc0c761/oss-sg/notes_pre_post/1040g3mo326idkoe5jk5g5oqi8i765mtspci1508!nd_dft_wlteh_jpg_3',
    infoList: [],
  };
  const c = X.imageCandidates(img);
  assert.equal(c[0], 'https://sns-img-bd.xhscdn.com/oss-sg/notes_pre_post/1040g3mo326idkoe5jk5g5oqi8i765mtspci1508');
  assert.equal(c[1], 'https://ci.xiaohongshu.com/oss-sg/notes_pre_post/1040g3mo326idkoe5jk5g5oqi8i765mtspci1508');
  assert(c[2].startsWith('https://sns-webpic-qc.xhscdn.com/'));
  assert.equal(X.imageCandidates({ fileId: '', urlDefault: img.urlDefault })[0], c[0]);
});

test('格式转换规则', () => {
  assert.equal(X.targetImageExt('heic', 'original'), 'jpg');
  assert.equal(X.targetImageExt('avif', 'original'), 'jpg');
  assert.equal(X.targetImageExt('png', 'original'), '');
  assert.equal(X.targetImageExt('jpg', 'original'), '');
  assert.equal(X.targetImageExt('png', 'jpg'), 'jpg');
  assert.equal(X.targetImageExt('jpg', 'jpg'), '');
  assert.equal(X.targetImageExt('jpg', 'png'), 'png');
  assert.equal(X.targetImageExt('png', 'png'), '');
  assert.equal(X.convertedImageUrl('https://sns-img-bd.xhscdn.com/notes_pre_post/abc', 'jpg'), 'https://sns-img-bd.xhscdn.com/notes_pre_post/abc?imageView2/format/jpg/q/95');
  assert.equal(X.convertedImageUrl('https://ci.xiaohongshu.com/notes_pre_post/abc', 'png'), 'https://ci.xiaohongshu.com/notes_pre_post/abc?imageView2/format/png');
  assert.equal(X.convertedImageUrl('https://sns-webpic-qc.xhscdn.com/1/2/abc!nd_dft_wlteh_webp_3', 'jpg'), '');
  assert.equal(X.convertedImageUrl('https://sns-img-bd.xhscdn.com/abc?x=1', 'jpg'), '');
  assert.equal(X.convertedImageUrl('https://sns-img-bd.xhscdn.com/abc', 'gif'), '');
});

test('视频：优先完整 mp4，其次分辨率高的', () => {
  const stream = {
    EF6: [],
    EF7: [],
    EF5: [{ format: 'fmp4', width: 1080, height: 1920, avgBitrate: 1127211, masterUrl: 'http://sns-video-v3.xhscdn.com/stream/1/110/3091/x_3091.m4s?sign=a', backupUrls: [] }],
    EF4: [
      {
        format: 'mp4',
        width: 720,
        height: 1280,
        avgBitrate: 1738527,
        masterUrl: 'http://sns-video-v3.xhscdn.com/stream/79/110/258/x_258.mp4?sign=b&t=c',
        backupUrls: ['http://sns-bak-v1.xhscdn.com/stream/79/110/258/x_258.mp4'],
      },
    ],
  };
  assert.deepEqual(X.pickVideoUrls(stream), ['https://sns-video-v3.xhscdn.com/stream/79/110/258/x_258.mp4?sign=b&t=c', 'https://sns-bak-v1.xhscdn.com/stream/79/110/258/x_258.mp4']);
  assert.deepEqual(X.pickVideoUrls({}), []);
  const h264 = { h264: [{ masterUrl: 'http://a.xhscdn.com/1.mp4', width: 720, height: 1280 }, { masterUrl: 'http://a.xhscdn.com/2.mp4', width: 1080, height: 1920 }] };
  assert.equal(X.pickVideoUrls(h264)[0], 'https://a.xhscdn.com/2.mp4');
});

test('下载计划：普通图片、实况图、视频', () => {
  const mk = (i, live) => ({ fileId: 'notes_pre_post/tok' + i, livePhoto: !!live, stream: live ? { h264: [{ masterUrl: 'http://sns-video-bd.xhscdn.com/live' + i + '.mp4' }] } : {} });
  const note = { noteId: 'n', type: 'normal', title: '好看的图', imageList: [mk(1), mk(2, true), mk(3)] };
  let p = X.buildPlan(note, {});
  assert.equal(p.folder, '好看的图');
  assert.deepEqual(p.items.map((i) => i.name), ['01', '02', '03']);
  p = X.buildPlan(note, { downloadLive: true });
  assert.deepEqual(p.items.map((i) => i.name), ['01', '02', '02_实况', '03']);
  const many = { type: 'normal', title: 't', imageList: Array.from({ length: 120 }, (_, i) => mk(i)) };
  assert.equal(X.buildPlan(many, {}).items[0].name, '001');
  const video = { type: 'video', title: '视频', imageList: [mk(9)], video: { media: { stream: { EF4: [{ format: 'mp4', masterUrl: 'http://sns-video-v3.xhscdn.com/v.mp4' }] } } } };
  p = X.buildPlan(video, {});
  assert.deepEqual(p.items.map((i) => [i.name, i.kind]), [['封面', 'image'], ['视频', 'video']]);
  p = X.buildPlan(video, { downloadVideo: false });
  assert.deepEqual(p.items.map((i) => i.name), ['封面']);
});

test('按文件头识别格式', () => {
  const b = (...arr) => Uint8Array.from(arr);
  const str = (s) => Array.from(s, (c) => c.charCodeAt(0));
  assert.equal(X.sniffExt(b(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'jpg');
  assert.equal(X.sniffExt(b(0x89, ...str('PNG'), 0x0d, 0x0a)), 'png');
  assert.equal(X.sniffExt(b(...str('RIFF'), 1, 2, 3, 4, ...str('WEBPVP8 '))), 'webp');
  assert.equal(X.sniffExt(b(0, 0, 0, 0x18, ...str('ftypheic'), 0, 0, 0, 0, ...str('mif1heic'))), 'heic');
  assert.equal(X.sniffExt(b(0, 0, 0, 0x1c, ...str('ftypavif'), 0, 0, 0, 0, ...str('avifmif1'))), 'avif');
  assert.equal(X.sniffExt(b(0, 0, 0, 0x1c, ...str('ftypmif1'), 0, 0, 0, 0, ...str('avifmiaf'))), 'avif');
  assert.equal(X.sniffExt(b(0, 0, 0, 0x20, ...str('ftypisom'), 0, 0, 2, 0, ...str('isomiso2'))), 'mp4');
  assert.equal(X.sniffExt(b(...str('GIF89a'))), 'gif');
  assert.equal(X.sniffExt(b(...str('<?xml'))), '');
  assert.equal(X.extFromMime('image/jpeg; charset=binary'), 'jpg');
});

test('解析页面里的 __INITIAL_STATE__', () => {
  const html = '<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc":{"note":{"title":"t","x":undefined,"arr":[undefined,1]}}}},"u":undefined}</script></html>';
  const s = X.parseInitialState(html);
  assert.equal(s.note.noteDetailMap.abc.note.title, 't');
  assert.equal(s.note.noteDetailMap.abc.note.x, null);
  assert.deepEqual(s.note.noteDetailMap.abc.note.arr, [null, 1]);
  assert.equal(X.parseInitialState('<html></html>'), null);
});

test('解析笔记链接', () => {
  const id = '6ad1782d00000000180131cb';
  assert.deepEqual(X.parseNoteUrl('/explore/' + id + '?xsec_token=AB%3D&xsec_source=pc_feed'), { noteId: id, xsecToken: 'AB=', xsecSource: 'pc_feed' });
  assert.equal(X.parseNoteUrl('/discovery/item/' + id).noteId, id);
  assert.equal(X.parseNoteUrl('/search_result/' + id + '?xsec_token=x').xsecToken, 'x');
  assert.equal(X.parseNoteUrl('/user/profile/69c512c6000000003202e594/' + id + '?xsec_token=y&xsec_source=pc_user').noteId, id);
  assert.equal(X.parseNoteUrl('/user/profile/69c512c6000000003202e594'), null);
  assert.equal(X.parseNoteUrl('/livestream/570553192127844452?note_id=' + id), null);
  assert.equal(X.parseNoteUrl('/explore'), null);
});
