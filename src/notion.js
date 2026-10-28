// Cliente da API do Notion e as operações expostas como ferramentas para a IA.
import { blocksToMd, mdToBlocks, mdToRichText, plainText } from './markdown.js';

const API = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2025-09-03';
const MAX_DEPTH = 3; // níveis de blocos aninhados lidos por página
const MAX_BLOCKS = 1500; // teto de blocos lidos por página

export class NotionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, min, max, fallback) => Math.min(Math.max(Number(n) || fallback, min), max);
const isNotFound = e => e instanceof NotionError && (e.status === 404 || e.status === 400);

export function createClient(token) {
  if (!token) throw new Error('Token do Notion não configurado. Abra as opções da extensão.');

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(API + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && attempt < 3) {
        await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new NotionError(res.status, data.code, data.message || `HTTP ${res.status}`);
      return data;
    }
  }

  return {
    get: path => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
  };
}

// Aceita UUID com ou sem hífens, ou qualquer URL do Notion (inclusive ?p= de páginas em peek).
export function normalizeId(input) {
  if (!input) throw new Error('ID ou URL do Notion ausente.');
  const s = String(input).trim();
  const peek = s.match(/[?&]p=([0-9a-f]{32})/i);
  const seg = s.split(/[?#]/)[0].split('/').pop();
  const hex = peek ? peek[1] : seg.replace(/-/g, '').match(/[0-9a-f]{32}$/i)?.[0];
  if (!hex) throw new Error(`ID do Notion inválido: ${input}`);
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function titleOf(obj) {
  if (Array.isArray(obj.title)) return plainText(obj.title) || 'Sem título';
  const prop = Object.values(obj.properties || {}).find(p => p.type === 'title');
  return plainText(prop?.title) || 'Sem título';
}

function scalarToText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v.start ? (v.end ? `${v.start} → ${v.end}` : v.start) : '';
  return String(v);
}

export function propToText(p) {
  if (!p) return '';
  switch (p.type) {
    case 'title': case 'rich_text': return plainText(p[p.type]);
    case 'number': return scalarToText(p.number);
    case 'select': case 'status': return p[p.type]?.name ?? '';
    case 'multi_select': return p.multi_select.map(o => o.name).join(', ');
    case 'date': return scalarToText(p.date);
    case 'checkbox': return p.checkbox ? 'sim' : 'não';
    case 'url': case 'email': case 'phone_number': return p[p.type] ?? '';
    case 'people': return p.people.map(u => u.name || u.id).join(', ');
    case 'relation': return p.relation.map(r => r.id).join(', ');
    case 'files': return p.files.map(f => f.name).join(', ');
    case 'created_time': case 'last_edited_time': return p[p.type];
    case 'created_by': case 'last_edited_by': return p[p.type]?.name || p[p.type]?.id || '';
    case 'formula': return scalarToText(p.formula?.[p.formula.type]);
    case 'rollup': {
      const r = p.rollup;
      if (!r) return '';
      return r.type === 'array' ? r.array.map(propToText).filter(Boolean).join(', ') : scalarToText(r[r.type]);
    }
    case 'unique_id': return p.unique_id ? `${p.unique_id.prefix ? p.unique_id.prefix + '-' : ''}${p.unique_id.number}` : '';
    default: return '';
  }
}

function propsToText(properties = {}) {
  return Object.fromEntries(Object.entries(properties)
    .filter(([, p]) => p.type !== 'title')
    .map(([k, p]) => [k, propToText(p)])
    .filter(([, v]) => v !== ''));
}

const summarize = obj => ({
  id: obj.id,
  type: obj.object === 'page' ? 'page' : 'database',
  title: titleOf(obj),
  url: obj.url,
  last_edited: obj.last_edited_time,
});

export async function getSelf(client) {
  return client.get('/users/me');
}

export async function search(client, { query = '', limit = 10, type } = {}) {
  const body = { query: String(query || ''), page_size: clamp(limit, 1, 100, 10) };
  if (!body.query) body.sort = { direction: 'descending', timestamp: 'last_edited_time' };
  if (type) body.filter = { property: 'object', value: type === 'database' ? 'data_source' : 'page' };
  const res = await client.post('/search', body);
  return res.results.map(summarize);
}

async function fetchChildren(client, blockId, depth, budget) {
  const blocks = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const res = await client.get(`/blocks/${blockId}/children?${qs}`);
    for (const b of res.results) {
      if (budget.left-- <= 0) {
        budget.truncated = true;
        return blocks;
      }
      blocks.push(b);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  for (const b of blocks) {
    if (budget.truncated) break;
    const expandable = b.has_children && b.type !== 'child_page' && b.type !== 'child_database';
    if (expandable && (depth < MAX_DEPTH || b.type === 'table')) {
      b.children = await fetchChildren(client, b.id, depth + 1, budget);
    }
  }
  return blocks;
}

// Aceita tanto o ID de um banco de dados quanto o de uma fonte de dados (API 2025-09-03).
async function resolveDataSource(client, id) {
  try {
    return await client.get(`/data_sources/${id}`);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    const db = await client.get(`/databases/${id}`);
    const dsId = db.data_sources?.[0]?.id;
    if (!dsId) throw new Error('Este banco de dados não tem nenhuma fonte de dados acessível.');
    return client.get(`/data_sources/${dsId}`);
  }
}

export async function readPage(client, { id }) {
  const pageId = normalizeId(id);
  let page;
  try {
    page = await client.get(`/pages/${pageId}`);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    // Talvez seja um banco de dados; se também falhar, o erro original é o mais útil.
    try {
      return { kind: 'database', ...(await queryDatabase(client, { id: pageId })) };
    } catch {
      throw e;
    }
  }
  const budget = { left: MAX_BLOCKS, truncated: false };
  const blocks = await fetchChildren(client, pageId, 1, budget);
  return {
    kind: 'page',
    id: page.id,
    title: titleOf(page),
    url: page.url,
    properties: propsToText(page.properties),
    markdown: blocksToMd(blocks),
    truncated: budget.truncated,
  };
}

export async function queryDatabase(client, { id, filter, sorts, limit = 25 }) {
  const ds = await resolveDataSource(client, normalizeId(id));
  const body = { page_size: clamp(limit, 1, 100, 25) };
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;
  const res = await client.post(`/data_sources/${ds.id}/query`, body);
  return {
    id: ds.id,
    title: titleOf(ds),
    schema: Object.fromEntries(Object.entries(ds.properties).map(([k, p]) => [k, p.type])),
    rows: res.results.map(r => ({ id: r.id, url: r.url, title: titleOf(r), properties: propsToText(r.properties) })),
    has_more: res.has_more,
  };
}

// Converte um objeto simples { "Status": "Feito", "Tags": ["a","b"] } no formato da API, usando o esquema.
function buildProperties(schema, values) {
  const out = {};
  for (const [name, v] of Object.entries(values || {})) {
    const def = schema[name];
    if (!def) throw new Error(`Propriedade desconhecida: "${name}". Disponíveis: ${Object.keys(schema).join(', ')}`);
    switch (def.type) {
      case 'title': case 'rich_text': out[name] = { [def.type]: mdToRichText(String(v ?? '')) }; break;
      case 'number': out[name] = { number: v === null || v === '' ? null : Number(v) }; break;
      case 'select': case 'status': out[name] = { [def.type]: v ? { name: String(v) } : null }; break;
      case 'multi_select':
        out[name] = { multi_select: (Array.isArray(v) ? v : String(v).split(',')).map(s => ({ name: String(s).trim() })).filter(o => o.name) };
        break;
      case 'date': out[name] = { date: v ? (typeof v === 'object' ? v : { start: String(v) }) : null }; break;
      case 'checkbox': out[name] = { checkbox: v === true || v === 'true' || v === 'sim' }; break;
      case 'url': case 'email': case 'phone_number': out[name] = { [def.type]: v ? String(v) : null }; break;
      case 'relation': out[name] = { relation: (Array.isArray(v) ? v : [v]).map(x => ({ id: normalizeId(x) })) }; break;
      default: throw new Error(`A propriedade "${name}" (${def.type}) não pode ser preenchida por esta extensão.`);
    }
  }
  return out;
}

async function appendBlocks(client, id, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await client.patch(`/blocks/${id}/children`, { children: blocks.slice(i, i + 100) });
  }
}

async function isPage(client, id) {
  try {
    await client.get(`/pages/${id}`);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

export async function createPage(client, { parent_id, title, content = '', properties }, defaults = {}) {
  const raw = parent_id || defaults.parentId;
  if (!raw) throw new Error('Informe parent_id ou configure uma página de destino padrão nas opções.');
  const parentId = normalizeId(raw);
  const pageTitle = String(title || 'Sem título');
  const children = mdToBlocks(content);

  let parent;
  let props;
  if (await isPage(client, parentId)) {
    parent = { page_id: parentId };
    props = { title: { title: mdToRichText(pageTitle) } };
  } else {
    const ds = await resolveDataSource(client, parentId);
    const titleName = Object.keys(ds.properties).find(k => ds.properties[k].type === 'title');
    parent = { type: 'data_source_id', data_source_id: ds.id };
    props = { ...buildProperties(ds.properties, properties), [titleName]: { title: mdToRichText(pageTitle) } };
  }

  const page = await client.post('/pages', { parent, properties: props, children: children.slice(0, 100) });
  await appendBlocks(client, page.id, children.slice(100));
  return { id: page.id, url: page.url, title: pageTitle, blocks: children.length };
}

export async function appendToPage(client, { id, content = '' }) {
  const pageId = normalizeId(id);
  const blocks = mdToBlocks(content);
  if (!blocks.length) throw new Error('Nada para acrescentar: "content" está vazio.');
  await appendBlocks(client, pageId, blocks);
  return { id: pageId, blocks: blocks.length };
}
