(() => {
  'use strict';
  const X = globalThis.XHSDL;

  const FORMAT_HELP = {
    original: '原始分辨率和画质（推荐）。苹果 HEIC 格式会自动转成 JPG，方便在任何设备上打开',
    jpg: '全部存为 JPG，兼容性最好；原图本来就是 JPG 的不会重新压缩',
    png: '全部存为 PNG，无损但文件很大',
  };

  const $ = (sel) => document.querySelector(sel);
  const subInput = $('input[name="subDir"]');
  let current = Object.assign({}, X.DEFAULT_SETTINGS);
  let savedTimer = 0;
  let subTimer = 0;

  function updatePreview() {
    $('#formatHelp').textContent = FORMAT_HELP[current.imageFormat] || FORMAT_HELP.original;
    const sub = X.sanitizePath(subInput.value);
    const ext = current.imageFormat === 'png' ? 'png' : 'jpg';
    $('#pathPreview').textContent = '下载 / ' + (sub ? sub.split('/').join(' / ') + ' / ' : '') + '笔记标题 / 01.' + ext;
    $('#pathWarn').hidden = !X.looksLikeAbsolutePath(subInput.value);
  }

  function render() {
    for (const radio of document.querySelectorAll('input[name="imageFormat"]')) radio.checked = radio.value === current.imageFormat;
    $('input[name="downloadVideo"]').checked = !!current.downloadVideo;
    $('input[name="downloadLive"]').checked = !!current.downloadLive;
    $('input[name="likeAfterDownload"]').checked = !!current.likeAfterDownload;
    subInput.value = current.subDir || '';
    updatePreview();
  }

  function save(patch) {
    Object.assign(current, patch);
    updatePreview();
    chrome.storage.sync.set(patch).then(() => {
      const el = $('#saved');
      el.textContent = '已保存';
      el.classList.add('show');
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
    });
  }

  document.querySelector('main').addEventListener('change', (event) => {
    const t = event.target;
    if (t.name === 'imageFormat') save({ imageFormat: t.value });
    else if (t.name === 'downloadVideo' || t.name === 'downloadLive' || t.name === 'likeAfterDownload') save({ [t.name]: t.checked });
    else if (t.name === 'subDir') {
      clearTimeout(subTimer);
      const clean = X.sanitizePath(t.value);
      const warn = X.looksLikeAbsolutePath(t.value);
      t.value = clean;
      save({ subDir: clean });
      // 输入框已经换成清理后的路径，提示继续显示，告诉用户为什么盘符不见了
      if (warn) $('#pathWarn').hidden = false;
    }
  });

  subInput.addEventListener('input', () => {
    updatePreview();
    clearTimeout(subTimer);
    subTimer = setTimeout(() => save({ subDir: X.sanitizePath(subInput.value) }), 500);
  });

  // Edge、Brave 等浏览器也认 chrome:// 地址，会自动跳到各自的设置页
  for (const link of document.querySelectorAll('.open-download-settings')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });
  }

  chrome.storage.sync.get(X.DEFAULT_SETTINGS).then((s) => {
    current = Object.assign({}, X.DEFAULT_SETTINGS, s);
    render();
  });
  render();
})();
