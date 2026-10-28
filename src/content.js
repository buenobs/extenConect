// Content script: painel flutuante do Notion + execução dos comandos "notion_tool" escritos pela IA.
// Não usa innerHTML: sites como o Gemini exigem Trusted Types.
(() => {
  if (window.__notionConnector) return;

  const TOOL_KEY = 'notion_tool';
  const WRITE_TOOLS = new Set(['create_page', 'append_to_page']);
  const HISTORY_WINDOW_MS = 4000; // comandos vistos logo após abrir uma conversa são históricos: não rodam sozinhos
  const AUTO_RUN_LIMIT = 10; // execuções automáticas por janela, para a IA não entrar em loop
  const AUTO_RUN_WINDOW_MS = 5 * 60 * 1000;

  const settings = { maxChars: 30000, autoRunReads: false, autoSend: false, launcherBottom: 120 };

  const EXAMPLE = { [TOOL_KEY]: 'search', query: 'TERMO' };
  const INSTRUCTIONS = `Você tem acesso ao meu Notion por meio de uma extensão do navegador. Para usar uma ferramenta, responda com UM bloco de código contendo apenas um objeto JSON com a chave "${TOOL_KEY}" e pare. A extensão executa o comando e eu devolvo o resultado numa mensagem que começa com NOTION_RESULT.

Ferramentas:
• search — busca páginas e bancos de dados. Campos: query; limit (opcional, padrão 10); type (opcional: "page" ou "database").
• read_page — lê uma página em Markdown (ou as linhas, se for banco de dados). Campos: id (ID ou URL).
• query_database — lista linhas de um banco de dados. Campos: id; limit (opcional); filter e sorts (opcionais, no formato da API do Notion).
• create_page — cria uma página. Campos: parent_id (página ou banco de dados; opcional se eu tiver um destino padrão); title; content (Markdown); properties (opcional, só para bancos de dados: objeto simples nome → valor).
• append_to_page — acrescenta Markdown ao fim de uma página. Campos: id; content.

Formato (troque pelos valores reais): ${JSON.stringify(EXAMPLE)}

Regras: um comando por resposta; use os IDs que aparecem nos resultados; ferramentas de escrita só rodam se eu aprovar; não invente conteúdo do Notion — busque e leia antes de responder. Se entendeu, responda apenas "Pronto para usar o Notion."`;
  const IGNORED_SIGNATURES = new Set([JSON.stringify(EXAMPLE)]);

  // ---------- utilidades ----------

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    el.append(...children.flat().filter(c => c != null && c !== false));
    return el;
  }

  function applyStyles(root, css) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', {}, css));
    }
  }

  async function send(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      return res || { ok: false, error: 'Sem resposta da extensão.' };
    } catch (e) {
      return {
        ok: false,
        error: /context invalidated/i.test(e.message) ? 'A extensão foi atualizada — recarregue esta página.' : e.message,
      };
    }
  }

  const isVisible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  function truncate(text) {
    const max = Number(settings.maxChars) || 30000;
    return text.length > max ? `${text.slice(0, max)}\n\n[…resultado truncado em ${max} caracteres]` : text;
  }

  function describe(cmd) {
    const id = cmd.id ?? cmd.page_id ?? cmd.database_id ?? cmd.url ?? '';
    switch (cmd[TOOL_KEY]) {
      case 'search': return `buscar “${cmd.query ?? ''}”`;
      case 'read_page': return `ler ${id}`;
      case 'query_database': return `consultar banco ${id}`;
      case 'create_page': return `criar a página “${cmd.title ?? 'Sem título'}”`;
      case 'append_to_page': return `acrescentar conteúdo à página ${id}`;
      default: return cmd[TOOL_KEY];
    }
  }

  // ---------- caixa de mensagem da IA ----------

  const INPUT_SELECTORS = [
    '#prompt-textarea', // ChatGPT
    'div.ProseMirror[contenteditable="true"]', // Claude e outros com ProseMirror
    'rich-textarea .ql-editor', // Gemini
    '[contenteditable="true"][role="textbox"]',
    'textarea:not([readonly])',
    '[contenteditable="true"]',
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Enviar" i]',
    'button[aria-label*="Submit" i]',
  ];

  let lastEditable = null;
  let lastSelection = '';

  const editableRoot = el => {
    if (!(el instanceof Element)) return null;
    if (el.matches('textarea, input[type="text"], input:not([type])')) return el;
    return el.isContentEditable ? el.closest('[contenteditable="true"], [contenteditable=""]') || el : null;
  };

  document.addEventListener('focusin', e => {
    const el = editableRoot(e.target); // eventos de dentro do painel chegam aqui com target = host, que não é editável
    if (el) lastEditable = el;
  }, true);

  document.addEventListener('selectionchange', () => {
    const text = String(window.getSelection() || '');
    if (text.trim()) lastSelection = text;
  });

  function findInput() {
    const active = editableRoot(document.activeElement);
    if (active && isVisible(active)) return active;
    if (lastEditable?.isConnected && isVisible(lastEditable)) return lastEditable;
    for (const sel of INPUT_SELECTORS) {
      const el = [...document.querySelectorAll(sel)].find(isVisible);
      if (el) return el;
    }
    return null;
  }

  function clickSend(input) {
    const scopes = [input.closest('form'), document].filter(Boolean);
    for (const scope of scopes) {
      const selectors = scope === document ? SEND_SELECTORS : [...SEND_SELECTORS, 'button[type="submit"]'];
      for (const sel of selectors) {
        const btn = [...scope.querySelectorAll(sel)].find(b => !b.disabled && isVisible(b));
        if (btn) return btn.click();
      }
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }

  // Acrescenta o texto ao fim da caixa de mensagem. Retorna false se só conseguiu copiar.
  function insertIntoChat(text, { autoSend = false } = {}) {
    const el = findInput();
    if (!el) {
      navigator.clipboard?.writeText(text).catch(() => {});
      toast('Não encontrei a caixa de mensagem — o texto foi copiado. Cole com Ctrl+V.');
      return false;
    }
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, (el.value ? `${el.value}\n\n` : '') + text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (el.textContent.trim()) text = `\n\n${text}`;
      // Editores ricos (ProseMirror, Quill, Lexical) tratam "colar" preservando as quebras de linha.
      const data = new DataTransfer();
      data.setData('text/plain', text);
      const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      el.dispatchEvent(paste);
      if (!paste.defaultPrevented) document.execCommand('insertText', false, text);
    }
    if (autoSend) setTimeout(() => clickSend(el), 400);
    return true;
  }

  // ---------- painel ----------

  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .wrap {
      --bg: #ffffff; --fg: #191919; --muted: #6b6b6b; --line: #e6e6e3; --soft: #f5f5f3;
      --accent: #191919; --accent-fg: #ffffff; --ok: #2f7d4f; --err: #c4352b;
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg: #202020; --fg: #ebebea; --muted: #9b9b9b; --line: #353535; --soft: #2a2a2a;
              --accent: #ebebea; --accent-fg: #191919; --ok: #5fbf85; --err: #f0776d; }
    }
    .launcher {
      position: fixed; right: 16px; width: 40px; height: 40px; border-radius: 10px;
      background: #191919; color: #fff; border: 1px solid rgba(255,255,255,.18);
      box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: grab; display: grid; place-items: center;
      font: 600 21px Georgia, "Times New Roman", serif; user-select: none; touch-action: none; z-index: 1;
    }
    .launcher:hover { transform: scale(1.05); }
    .panel {
      position: fixed; right: 16px; bottom: 16px; width: min(400px, calc(100vw - 32px));
      max-height: min(640px, calc(100vh - 32px)); display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,.22); font-size: 13px; line-height: 1.4; overflow: hidden; z-index: 2;
    }
    [hidden] { display: none !important; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    header .logo { width: 22px; height: 22px; border-radius: 5px; background: #191919; color: #fff;
      display: grid; place-items: center; font: 600 13px Georgia, serif; border: 1px solid rgba(255,255,255,.2); }
    header strong { font-size: 13px; }
    header .who { color: var(--muted); font-size: 12px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
    nav { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); }
    nav button { background: none; border: none; color: var(--muted); padding: 6px 10px 8px; cursor: pointer;
      font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    nav button.active { color: var(--fg); border-bottom-color: var(--fg); font-weight: 600; }
    section { padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
    .row { display: flex; gap: 6px; align-items: center; }
    input[type="text"], textarea {
      width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--soft);
      color: var(--fg); font-size: 13px; outline: none; resize: vertical;
    }
    input[type="text"]:focus, textarea:focus { border-color: var(--muted); }
    textarea { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    label { display: flex; flex-direction: column; gap: 4px; font-weight: 500; }
    label small { color: var(--muted); font-weight: 400; }
    label.check { flex-direction: row; align-items: center; gap: 8px; font-weight: 400; cursor: pointer; }
    button.btn { padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg);
      color: var(--fg); cursor: pointer; font-size: 13px; white-space: nowrap; }
    button.btn:hover:not(:disabled) { background: var(--soft); }
    button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
    button.primary:hover:not(:disabled) { background: var(--accent); opacity: .88; }
    button:disabled { opacity: .45; cursor: default; }
    button.icon { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 15px; padding: 2px 4px; }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .results li { display: flex; align-items: center; gap: 8px; padding: 6px 6px; border-radius: 6px; }
    .results li:hover { background: var(--soft); }
    .results .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
    .results a, .results .mini { color: var(--muted); font-size: 12px; text-decoration: none; background: none; border: none; cursor: pointer; padding: 0 2px; }
    .results a:hover, .results .mini:hover { color: var(--fg); }
    .muted { color: var(--muted); }
    .error { color: var(--err); }
    .footer { padding: 10px 12px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .log li { font-size: 12px; padding: 4px 0; border-bottom: 1px solid var(--line); display: flex; gap: 6px; }
    .log .ok { color: var(--ok); } .log .err { color: var(--err); }
    .log time { color: var(--muted); font-variant-numeric: tabular-nums; }
    h4 { margin: 6px 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    p { margin: 0; }
    .setup { padding: 20px 16px; display: flex; flex-direction: column; gap: 10px; }
    .toast { position: fixed; right: 16px; bottom: 16px; max-width: 340px; background: #191919; color: #fff;
      padding: 10px 14px; border-radius: 8px; font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,.25); z-index: 3; }
  `;

  const host = h('notion-connector-root');
  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow, PANEL_CSS);
  // Evita que atalhos de teclado do site disparem enquanto se digita no painel.
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, e => e.stopPropagation());

  const ui = {};
  const selected = new Map(); // id -> item da busca

  const tabButton = (name, label) => h('button', { 'data-tab': name, onclick: () => showTab(name) }, label);

  ui.launcher = h('div', { class: 'launcher', title: 'Conector Notion (Ctrl+Shift+Y) — arraste para mover' }, 'N');
  ui.who = h('span', { class: 'who' });
  ui.results = h('ul', { class: 'results' });
  ui.query = h('input', { type: 'text', placeholder: 'Buscar no Notion…', autocomplete: 'off' });
  ui.insertBtn = h('button', { class: 'btn primary', disabled: true, onclick: insertSelected }, 'Inserir no chat');
  ui.selCount = h('span', { class: 'muted' }, 'Nada selecionado');
  ui.title = h('input', { type: 'text', placeholder: 'Título da nova página' });
  ui.parent = h('input', { type: 'text', placeholder: 'Vazio = destino padrão das opções' });
  ui.content = h('textarea', { rows: '9', placeholder: 'Conteúdo em Markdown' });
  ui.createBtn = h('button', { class: 'btn primary', onclick: createFromPanel }, 'Criar página');
  ui.saveStatus = h('p', { class: 'muted' });
  ui.autoRun = h('input', { type: 'checkbox', onchange: e => chrome.storage.local.set({ autoRunReads: e.target.checked }) });
  ui.autoSend = h('input', { type: 'checkbox', onchange: e => chrome.storage.local.set({ autoSend: e.target.checked }) });
  ui.log = h('ul', { class: 'log' }, h('li', { class: 'muted' }, 'Nenhum comando executado ainda.'));
  ui.toast = h('div', { class: 'toast', hidden: true });

  ui.panes = {
    search: h('section', {},
      h('form', { class: 'row', onsubmit: e => { e.preventDefault(); doSearch(ui.query.value); } },
        ui.query, h('button', { class: 'btn primary' }, 'Buscar')),
      ui.results),
    save: h('section', { hidden: true },
      h('label', {}, 'Título', ui.title),
      h('label', {}, h('span', {}, 'Destino ', h('small', {}, '(URL ou ID de página/banco; use “→ destino” na busca)')), ui.parent),
      h('label', {}, 'Conteúdo', ui.content),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { ui.content.value = lastSelection; } }, 'Usar texto selecionado'),
        h('span', { style: 'flex:1' }),
        ui.createBtn),
      ui.saveStatus),
    ai: h('section', { hidden: true },
      h('p', {}, 'Ensine a IA desta aba a usar o Notion. Ela passará a responder com comandos; um botão aparece abaixo de cada um para executá-lo.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => insertIntoChat(INSTRUCTIONS) && toast('Instruções inseridas — revise e envie.') }, 'Ensinar a IA'),
        h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(INSTRUCTIONS).then(() => toast('Instruções copiadas.')) }, 'Copiar instruções')),
      h('label', { class: 'check' }, ui.autoRun, 'Executar leituras automaticamente'),
      h('label', { class: 'check' }, ui.autoSend, 'Enviar o resultado à IA automaticamente'),
      h('p', { class: 'muted' }, 'Criar ou alterar páginas sempre pede sua confirmação.'),
      h('h4', {}, 'Atividade'),
      ui.log),
  };

  ui.searchFooter = h('div', { class: 'footer' }, ui.selCount, ui.insertBtn);
  ui.nav = h('nav', {}, tabButton('search', 'Buscar'), tabButton('save', 'Salvar'), tabButton('ai', 'IA'));
  ui.setup = h('div', { class: 'setup', hidden: true },
    h('strong', {}, 'Conecte seu Notion'),
    h('p', { class: 'muted' }, 'Cole o token de uma integração interna do Notion nas opções da extensão e compartilhe com ela as páginas que a IA pode acessar.'),
    h('div', {}, h('button', { class: 'btn primary', onclick: () => send({ type: 'openOptions' }) }, 'Abrir opções')));
  ui.main = h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
    ui.nav, ui.panes.search, ui.panes.save, ui.panes.ai, ui.searchFooter);
  ui.panel = h('div', { class: 'panel', hidden: true },
    h('header', {},
      h('span', { class: 'logo' }, 'N'), h('strong', {}, 'Conector Notion'), ui.who,
      h('button', { class: 'icon', title: 'Fechar', onclick: () => setOpen(false) }, '✕')),
    ui.setup, ui.main);

  shadow.append(h('div', { class: 'wrap' }, ui.launcher, ui.panel, ui.toast));

  let toastTimer;
  function toast(text) {
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 3500);
  }

  function showTab(name) {
    for (const [k, pane] of Object.entries(ui.panes)) pane.hidden = k !== name;
    for (const b of ui.nav.children) b.classList.toggle('active', b.dataset.tab === name);
    ui.searchFooter.hidden = name !== 'search';
  }

  let status = null;
  async function refreshStatus() {
    status = await send({ type: 'status' });
    const configured = status.ok && status.configured;
    ui.setup.hidden = configured;
    ui.main.hidden = !configured;
    ui.who.textContent = configured ? status.name : '';
    if (!status.ok) {
      ui.setup.hidden = false;
      ui.setup.querySelector('p').textContent = `Erro ao conectar: ${status.error}`;
    }
    return configured;
  }

  async function setOpen(open) {
    ui.panel.hidden = !open;
    ui.launcher.hidden = open;
    if (!open) return;
    if (await refreshStatus()) {
      if (!ui.results.children.length) doSearch('');
      ui.query.focus();
    }
  }
  const toggle = () => setOpen(ui.panel.hidden);

  // Arrastar o botão na vertical; um toque sem arrastar abre o painel.
  ui.launcher.addEventListener('pointerdown', e => {
    const startY = e.clientY;
    const startBottom = settings.launcherBottom;
    let moved = false;
    ui.launcher.setPointerCapture(e.pointerId);
    const move = ev => {
      if (Math.abs(ev.clientY - startY) > 4) moved = true;
      if (moved) placeLauncher(Math.min(startBottom - (ev.clientY - startY), window.innerHeight - 56));
    };
    const up = () => {
      ui.launcher.removeEventListener('pointermove', move);
      ui.launcher.removeEventListener('pointerup', up);
      if (moved) chrome.storage.local.set({ launcherBottom: settings.launcherBottom });
      else setOpen(true);
    };
    ui.launcher.addEventListener('pointermove', move);
    ui.launcher.addEventListener('pointerup', up);
  });

  // O CSS mantém o botão dentro da tela mesmo se a janela mudar de tamanho depois.
  function placeLauncher(bottom) {
    settings.launcherBottom = Math.max(Number(bottom) || 120, 8);
    ui.launcher.style.bottom = `clamp(8px, ${settings.launcherBottom}px, calc(100vh - 56px))`;
  }

  // ---------- aba Buscar ----------

  function updateSelection() {
    ui.insertBtn.disabled = !selected.size;
    ui.selCount.textContent = selected.size ? `${selected.size} selecionado(s)` : 'Nada selecionado';
  }

  function renderResults(items) {
    if (!items.length) {
      ui.results.replaceChildren(h('li', { class: 'muted' }, 'Nada encontrado. Lembre de compartilhar as páginas com a integração (••• › Conexões).'));
      return;
    }
    ui.results.replaceChildren(...items.map(item => {
      const box = h('input', {
        type: 'checkbox',
        checked: selected.has(item.id),
        onchange: e => { e.target.checked ? selected.set(item.id, item) : selected.delete(item.id); updateSelection(); },
      });
      return h('li', {},
        box,
        h('span', { class: 'title', title: item.title, onclick: () => box.click() }, `${item.type === 'database' ? '🗃️' : '📄'} ${item.title}`),
        h('button', {
          class: 'mini', title: 'Usar como destino na aba Salvar',
          onclick: () => { ui.parent.value = item.id; showTab('save'); toast(`Destino: ${item.title}`); },
        }, '→ destino'),
        item.url ? h('a', { href: item.url, target: '_blank', rel: 'noopener', title: 'Abrir no Notion' }, '↗') : null);
    }));
  }

  async function doSearch(query) {
    ui.results.replaceChildren(h('li', { class: 'muted' }, query ? 'Buscando…' : 'Carregando páginas recentes…'));
    const res = await send({ type: 'tool', command: { [TOOL_KEY]: 'search', query, limit: 20 } });
    if (!res.ok) return ui.results.replaceChildren(h('li', { class: 'error' }, res.error));
    renderResults(res.result);
  }

  async function insertSelected() {
    const items = [...selected.values()];
    ui.insertBtn.disabled = true;
    ui.insertBtn.textContent = 'Lendo…';
    const parts = [];
    for (const item of items) {
      const tool = item.type === 'database' ? 'query_database' : 'read_page';
      const res = await send({ type: 'tool', command: { [TOOL_KEY]: tool, id: item.id } });
      parts.push(res.ok ? res.text : `# ${item.title}\n(erro ao ler: ${res.error})`);
    }
    ui.insertBtn.textContent = 'Inserir no chat';
    updateSelection();
    if (insertIntoChat(truncate(`Contexto do meu Notion:\n\n${parts.join('\n\n---\n\n')}`))) {
      toast(`${items.length} item(ns) inserido(s) no chat.`);
      selected.clear();
      updateSelection();
      for (const box of ui.results.querySelectorAll('input[type="checkbox"]')) box.checked = false;
    }
  }

  // ---------- aba Salvar ----------

  async function createFromPanel() {
    const command = { [TOOL_KEY]: 'create_page', title: ui.title.value.trim(), content: ui.content.value, parent_id: ui.parent.value.trim() || undefined };
    if (!command.title) return ui.title.focus();
    ui.createBtn.disabled = true;
    ui.saveStatus.className = 'muted';
    ui.saveStatus.textContent = 'Criando…';
    const res = await send({ type: 'tool', command, confirmed: true });
    ui.createBtn.disabled = false;
    if (!res.ok) {
      ui.saveStatus.className = 'error';
      ui.saveStatus.textContent = res.error;
      return;
    }
    ui.saveStatus.replaceChildren('✓ Página criada: ', h('a', { href: res.result.url, target: '_blank', rel: 'noopener' }, res.result.title));
    ui.title.value = '';
    ui.content.value = '';
  }

  // ---------- aba IA: comandos nas respostas ----------

  function logActivity(cmd, ok, detail) {
    if (ui.log.firstChild?.classList.contains('muted')) ui.log.replaceChildren();
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ui.log.prepend(h('li', {}, h('time', {}, time), h('span', { class: ok ? 'ok' : 'err' }, ok ? '✓' : '✗'), h('span', {}, `${describe(cmd)}${detail ? ` — ${detail}` : ''}`)));
    while (ui.log.children.length > 30) ui.log.lastChild.remove();
  }

  function parseCommand(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      return obj && typeof obj === 'object' && typeof obj[TOOL_KEY] === 'string' ? obj : null;
    } catch {
      return null;
    }
  }

  const BAR_CSS = `
    :host { all: initial; display: block; margin: 6px 0 14px; }
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 7px 10px; border-radius: 8px;
      border: 1px solid rgba(128,128,128,.35); background: rgba(128,128,128,.08); color: inherit;
      font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .tag { width: 20px; height: 20px; border-radius: 5px; background: #191919; color: #fff; display: grid;
      place-items: center; font: 600 12px Georgia, serif; border: 1px solid rgba(255,255,255,.25); flex: none; }
    .desc { flex: 1; min-width: 140px; }
    button { padding: 5px 11px; border-radius: 6px; border: 1px solid #191919; background: #191919; color: #fff;
      cursor: pointer; font: 500 12px ui-sans-serif, system-ui, sans-serif; }
    button.write { background: #b4541a; border-color: #b4541a; }
    button:disabled { opacity: .5; cursor: default; }
    .state { width: 100%; font-size: 12px; opacity: .8; }
    .state:empty { display: none; }
  `;

  function makeBar(cmd) {
    const barHost = document.createElement('notion-connector-bar');
    const root = barHost.attachShadow({ mode: 'open' });
    applyStyles(root, BAR_CSS);
    const isWrite = WRITE_TOOLS.has(cmd[TOOL_KEY]);
    const button = h('button', { class: isWrite ? 'write' : '' }, isWrite ? 'Revisar e executar' : 'Executar');
    const state = h('span', { class: 'state' });
    root.append(h('div', { class: 'bar' },
      h('span', { class: 'tag' }, 'N'),
      h('span', { class: 'desc' }, `Notion: ${describe(cmd)}`),
      button, state));
    const bar = {
      host: barHost,
      setState: (text, busy = false) => { state.textContent = text; button.disabled = busy; },
      done: () => { button.textContent = 'Executar de novo'; },
    };
    button.addEventListener('click', e => { e.stopPropagation(); execute(cmd, bar); });
    return bar;
  }

  async function execute(cmd, bar) {
    if (WRITE_TOOLS.has(cmd[TOOL_KEY])) {
      const preview = JSON.stringify(cmd, null, 2);
      const ok = window.confirm(`A IA quer ${describe(cmd)} no seu Notion.\n\n${preview.length > 900 ? preview.slice(0, 900) + '\n…' : preview}\n\nConfirmar?`);
      if (!ok) return bar.setState('Cancelado por você.');
    }
    bar.setState('Executando no Notion…', true);
    const res = await send({ type: 'tool', command: cmd, confirmed: true });
    logActivity(cmd, res.ok, res.ok ? '' : res.error);
    const body = res.ok ? res.text : `ERRO: ${res.error}`;
    const inserted = insertIntoChat(truncate(`NOTION_RESULT ${cmd[TOOL_KEY]}\n${body}`), { autoSend: settings.autoSend });
    bar.done();
    bar.setState(res.ok
      ? (inserted ? (settings.autoSend ? '✓ Resultado enviado à IA.' : '✓ Resultado inserido no chat — envie para a IA continuar.') : '✓ Resultado copiado.')
      : `✗ ${res.error} (o erro foi passado para a IA)`);
  }

  const bars = new WeakMap(); // <pre> -> { sig, bar }
  const autoRan = new WeakSet();
  const autoRunTimes = [];
  let historyUntil = Date.now() + HISTORY_WINDOW_MS;
  let lastUrl = location.href;

  function allowAutoRun() {
    const now = Date.now();
    while (autoRunTimes.length && now - autoRunTimes[0] > AUTO_RUN_WINDOW_MS) autoRunTimes.shift();
    if (autoRunTimes.length >= AUTO_RUN_LIMIT) {
      toast('Execução automática pausada: muitos comandos seguidos. Use os botões para continuar.');
      return false;
    }
    autoRunTimes.push(now);
    return true;
  }

  function scan() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      historyUntil = Date.now() + HISTORY_WINDOW_MS;
    }
    for (const pre of document.querySelectorAll('pre')) {
      const cmd = parseCommand((pre.querySelector('code') || pre).textContent);
      if (!cmd) continue;
      const sig = JSON.stringify(cmd);
      if (IGNORED_SIGNATURES.has(sig)) continue;
      const known = bars.get(pre);
      if (known && known.sig === sig && known.bar.host.isConnected) continue;
      known?.bar.host.remove();
      const bar = makeBar(cmd);
      pre.insertAdjacentElement('afterend', bar.host);
      bars.set(pre, { sig, bar });

      const historic = Date.now() < historyUntil;
      if (historic) autoRan.add(pre);
      if (settings.autoRunReads && !WRITE_TOOLS.has(cmd[TOOL_KEY]) && !autoRan.has(pre) && allowAutoRun()) {
        autoRan.add(pre);
        execute(cmd, bar);
      }
    }
  }

  // Varre depois que a página "sossega" (fim do streaming), mas nunca espera mais que 3 s.
  let scanTimer;
  let pendingSince = 0;
  new MutationObserver(() => {
    const now = Date.now();
    pendingSince ||= now;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { pendingSince = 0; scan(); }, now - pendingSince > 3000 ? 0 : 900);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // ---------- inicialização ----------

  chrome.storage.local.get(Object.keys(settings)).then(stored => {
    Object.assign(settings, stored);
    ui.autoRun.checked = !!settings.autoRunReads;
    ui.autoSend.checked = !!settings.autoSend;
    placeLauncher(settings.launcherBottom);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) if (key in settings) settings[key] = newValue;
    ui.autoRun.checked = !!settings.autoRunReads;
    ui.autoSend.checked = !!settings.autoSend;
    if (changes.token && !ui.panel.hidden) refreshStatus();
  });

  showTab('search');
  placeLauncher(settings.launcherBottom);
  document.documentElement.append(host);
  scan();

  window.__notionConnector = { toggle, open: () => setOpen(true) };
})();
