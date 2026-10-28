const $ = id => document.getElementById(id);

function showError(text) {
  $('error').textContent = text;
  $('error').hidden = false;
}

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('open').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'togglePanel', tabId: tab.id });
  if (res.ok) window.close();
  else showError(res.error);
});

for (const key of ['autoRunReads', 'autoSend']) {
  $(key).addEventListener('change', e => chrome.storage.local.set({ [key]: e.target.checked }));
}

const stored = await chrome.storage.local.get(['autoRunReads', 'autoSend']);
$('autoRunReads').checked = !!stored.autoRunReads;
$('autoSend').checked = !!stored.autoSend;

const status = await chrome.runtime.sendMessage({ type: 'status' });
if (!status.ok) {
  $('status').textContent = 'Não foi possível conectar ao Notion.';
  showError(status.error);
} else if (!status.configured) {
  $('status').textContent = 'Token não configurado — abra as opções.';
} else {
  $('status').textContent = `Conectado como “${status.name}”.`;
  $('status').className = 'ok';
}
