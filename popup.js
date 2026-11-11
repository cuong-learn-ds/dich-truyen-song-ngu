const $ = (id) => document.getElementById(id);

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function askTab(tab, msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null; // chrome:// pages, or tab opened before the extension was installed
  }
}

async function refreshCacheCount() {
  const { count } = await chrome.runtime.sendMessage({ type: 'cacheStats' });
  $('cacheCount').textContent = count;
}

async function init() {
  const tab = await getTab();
  let host = '';
  try { host = new URL(tab.url).hostname; } catch {}
  $('host').textContent = host || 'này';

  const s = await chrome.storage.local.get(['enabled', 'mode', 'disabledSites', 'mangaAuto']);
  const disabledSites = s.disabledSites || [];
  $('enabled').checked = s.enabled !== false;
  $('mangaAuto').checked = s.mangaAuto !== false;
  $('mangaAuto').onchange = (e) => chrome.storage.local.set({ mangaAuto: e.target.checked });
  $('cookies').checked = await chrome.permissions.contains({ permissions: ['cookies'] });
  $('cookies').onchange = async (e) => {
    // permissions.request needs a user gesture: this change event counts.
    e.target.checked = e.target.checked
      ? await chrome.permissions.request({ permissions: ['cookies'] })
      : !(await chrome.permissions.remove({ permissions: ['cookies'] }));
  };
  $('siteEnabled').checked =!disabledSites.includes(host);
  document.querySelector(`input[name=mode][value=${s.mode || 'bilingual'}]`).checked = true;

  $('enabled').onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });

  $('siteEnabled').onchange = async (e) => {
    const { disabledSites: list = [] } = await chrome.storage.local.get('disabledSites');
    const next = e.target.checked ? list.filter((h) => h !== host) : [...new Set([...list, host])];
    await chrome.storage.local.set({ disabledSites: next });
  };

  document.querySelectorAll('input[name=mode]').forEach((r) => {
    r.onchange = () => chrome.storage.local.set({ mode: r.value });
  });

  $('clear').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    refreshCacheCount();
  };

  const status = await askTab(tab, { type: 'pageStatus' });
  const manga = await askTab(tab, { type: 'mangaStatus' });
  if (!status) {
    $('status').textContent = 'Không chạy được trên trang này (hãy tải lại trang nếu vừa cài extension).';
  } else if (manga && manga.active) {
    $('status').textContent = `Đang dịch truyện tranh: ${manga.images} ảnh, ${manga.boxes} ô thoại đã dịch.`;
  } else if (status.active) {
    $('status').textContent = 'Đang dịch truyện chữ trên trang này.';
  } else {
    $('status').textContent = 'Không thấy truyện chữ/tranh ở đây. Vẫn có thể giữ Alt + kéo chuột để dịch.';
    $('force').hidden = false;
    $('force').onclick = async () => {
      const r = await askTab(tab, { type: 'forceStart' });
      $('status').textContent = r && r.active ? 'Đang dịch trang này.' : 'Hãy bật dịch trước.';
      if (r && r.active) $('force').hidden = true;
    };
  }

  refreshCacheCount();
}

init();
