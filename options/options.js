import { normalizeId } from '../src/notion.js';

const $ = id => document.getElementById(id);
const DEFAULTS = { token: '', defaultParentId: '', maxChars: 30000, autoRunReads: false, autoSend: false };

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $('token').value = s.token;
  $('defaultParentId').value = s.defaultParentId;
  $('maxChars').value = s.maxChars;
  $('autoRunReads').checked = s.autoRunReads;
  $('autoSend').checked = s.autoSend;
}

function setResult(el, text, cls) {
  el.textContent = text;
  el.className = `${cls} small`;
}

$('save').addEventListener('click', async () => {
  const parent = $('defaultParentId').value.trim();
  let defaultParentId = '';
  try {
    defaultParentId = parent ? normalizeId(parent) : '';
  } catch (e) {
    return setResult($('testResult'), e.message, 'error');
  }
  await chrome.storage.local.set({
    token: $('token').value.trim(),
    defaultParentId,
    maxChars: Math.max(1000, Number($('maxChars').value) || DEFAULTS.maxChars),
    autoRunReads: $('autoRunReads').checked,
    autoSend: $('autoSend').checked,
  });
  $('defaultParentId').value = defaultParentId;
  $('saved').hidden = false;
  setTimeout(() => { $('saved').hidden = true; }, 2000);
});

$('test').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: $('token').value.trim() });
  setResult($('testResult'), 'Testando…', 'muted');
  const res = await chrome.runtime.sendMessage({ type: 'status' });
  if (!res.ok) setResult($('testResult'), `Falhou: ${res.error}`, 'error');
  else if (!res.configured) setResult($('testResult'), 'Cole um token primeiro.', 'error');
  else setResult($('testResult'), `Conectado como “${res.name}” ✓`, 'ok');
});

// ---------- sites extras ----------

async function renderSites() {
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  $('sites').replaceChildren(...scripts.map(s => {
    const remove = document.createElement('button');
    remove.textContent = 'Remover';
    remove.addEventListener('click', async () => {
      await chrome.scripting.unregisterContentScripts({ ids: [s.id] });
      await chrome.permissions.remove({ origins: s.matches });
      renderSites();
    });
    const li = document.createElement('li');
    li.append(s.matches.join(', '), remove);
    return li;
  }));
}

$('addSite').addEventListener('click', async () => {
  $('siteError').hidden = true;
  const raw = $('siteInput').value.trim();
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    $('siteError').textContent = 'Endereço inválido.';
    $('siteError').hidden = false;
    return;
  }
  const origin = `${url.protocol}//${url.hostname}/*`;
  // O pedido de permissão precisa acontecer direto no clique.
  if (!(await chrome.permissions.request({ origins: [origin] }))) return;
  try {
    await chrome.scripting.registerContentScripts([{
      id: `site-${url.hostname}`,
      matches: [origin],
      js: ['src/content.js'],
      runAt: 'document_idle',
    }]);
  } catch (e) {
    $('siteError').textContent = e.message;
    $('siteError').hidden = false;
  }
  $('siteInput').value = '';
  renderSites();
});

load();
renderSites();
