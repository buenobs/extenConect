// Service worker: executa as ferramentas do Notion pedidas pelo content script, popup e opções.
import { appendToPage, createClient, createPage, getSelf, queryDatabase, readPage, search } from './notion.js';

const DEFAULTS = { token: '', defaultParentId: '', maxChars: 30000, autoRunReads: false, autoSend: false };

const getSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });

const idArg = a => a.id ?? a.page_id ?? a.database_id ?? a.data_source_id ?? a.url;

const TOOLS = {
  search: { write: false, run: (c, a) => search(c, a) },
  read_page: { write: false, run: (c, a) => readPage(c, { id: idArg(a) }) },
  query_database: { write: false, run: (c, a) => queryDatabase(c, { ...a, id: idArg(a) }) },
  create_page: {
    write: true,
    run: (c, a, s) => createPage(c, { ...a, parent_id: a.parent_id ?? a.parent }, { parentId: s.defaultParentId }),
  },
  append_to_page: { write: true, run: (c, a) => appendToPage(c, { id: idArg(a), content: a.content }) },
};

const typeLabel = t => (t === 'database' ? 'banco de dados' : 'página');

function formatPage(p) {
  const lines = [`# ${p.title}`, `id: ${p.id}`, `url: ${p.url}`];
  for (const [k, v] of Object.entries(p.properties)) lines.push(`${k}: ${v}`);
  lines.push('', p.markdown || '(página vazia)');
  if (p.truncated) lines.push('', '[conteúdo truncado: a página é grande demais]');
  return lines.join('\n');
}

function formatDatabase(d) {
  const lines = [
    `# Banco de dados: ${d.title}`,
    `id: ${d.id}`,
    `Propriedades: ${Object.entries(d.schema).map(([k, t]) => `${k} (${t})`).join(', ')}`,
    '',
  ];
  if (!d.rows.length) lines.push('(nenhuma linha encontrada)');
  for (const r of d.rows) {
    const props = Object.entries(r.properties).map(([k, v]) => `${k}: ${v}`).join('; ');
    lines.push(`- ${r.title} — id: ${r.id}${props ? ` — ${props}` : ''}`);
  }
  if (d.has_more) lines.push('', '[há mais linhas: use "limit" ou um "filter" para refinar]');
  return lines.join('\n');
}

function formatResult(tool, r) {
  switch (tool) {
    case 'search':
      if (!r.length) return 'Nenhum resultado. Só aparecem páginas compartilhadas com a integração (menu ••• › Conexões no Notion).';
      return r.map((x, i) => `${i + 1}. [${typeLabel(x.type)}] ${x.title} — id: ${x.id}${x.url ? ` — ${x.url}` : ''}`).join('\n');
    case 'read_page': return r.kind === 'database' ? formatDatabase(r) : formatPage(r);
    case 'query_database': return formatDatabase(r);
    case 'create_page': return `Página criada: "${r.title}" — id: ${r.id} — ${r.url}`;
    case 'append_to_page': return `${r.blocks} bloco(s) acrescentado(s) à página ${r.id}.`;
    default: return JSON.stringify(r, null, 2);
  }
}

async function runTool(command, confirmed) {
  const name = command?.notion_tool;
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Ferramenta desconhecida: "${name}". Disponíveis: ${Object.keys(TOOLS).join(', ')}`);
  if (tool.write && !confirmed) throw new Error('Ferramentas de escrita exigem confirmação do usuário.');
  const settings = await getSettings();
  const result = await tool.run(createClient(settings.token), command, settings);
  return { result, text: formatResult(name, result) };
}

// Injeta o content script (se ainda não estiver na aba) e abre/fecha o painel.
async function togglePanel(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__notionConnector?.toggle() });
  } catch (e) {
    throw new Error(/cannot (access|be scripted)|chrome:\/\//i.test(e.message)
      ? 'O Chrome não permite extensões nesta página. Abra o site da IA e tente de novo.'
      : e.message);
  }
}

async function handle(msg) {
  switch (msg?.type) {
    case 'status': {
      const { token } = await getSettings();
      if (!token) return { configured: false };
      const me = await getSelf(createClient(token));
      return { configured: true, name: me.name || me.bot?.workspace_name || 'integração' };
    }
    case 'tool': return runTool(msg.command, msg.confirmed);
    case 'togglePanel': await togglePanel(msg.tabId); return {};
    case 'openOptions': await chrome.runtime.openOptionsPage(); return {};
    default: throw new Error(`Mensagem desconhecida: ${msg?.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    data => sendResponse({ ok: true, ...data }),
    err => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true; // resposta assíncrona
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-panel') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) togglePanel(tab.id).catch(e => console.warn('[Conector Notion]', e.message));
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
