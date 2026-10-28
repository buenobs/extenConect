// Conversão entre blocos do Notion e Markdown.

const MAX_TEXT = 2000; // limite de caracteres por objeto rich_text na API
const MAX_NESTING = 2; // a API aceita no máximo 2 níveis de filhos por requisição

const LIST_TYPES = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle']);

const CODE_LANGS = new Set([
  'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css', 'dart', 'diff',
  'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin', 'glsl', 'go', 'graphql', 'groovy',
  'haskell', 'html', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript',
  'lua', 'makefile', 'markdown', 'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal',
  'perl', 'php', 'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust',
  'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift', 'typescript', 'vb.net', 'verilog', 'vhdl',
  'visual basic', 'webassembly', 'xml', 'yaml',
]);

const LANG_ALIASES = {
  '': 'plain text', text: 'plain text', txt: 'plain text', plaintext: 'plain text',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', sh: 'shell', zsh: 'shell', ps1: 'powershell', ps: 'powershell', pwsh: 'powershell',
  yml: 'yaml', md: 'markdown', cpp: 'c++', cs: 'c#', csharp: 'c#', rb: 'ruby', rs: 'rust',
  kt: 'kotlin', golang: 'go', dockerfile: 'docker', tex: 'latex', objc: 'objective-c', vb: 'visual basic',
};

export function plainText(rich = []) {
  return (rich || []).map(r => r.plain_text ?? r.text?.content ?? '').join('');
}

// ---------- Notion → Markdown ----------

// Aplica a marcação só ao miolo do texto, deixando espaços das bordas de fora ("**a** " e não "**a **").
function wrap(text, mark) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

export function richTextToMd(rich = []) {
  return (rich || []).map(r => {
    if (r.type === 'equation') return `$${r.equation.expression}$`;
    let t = r.plain_text ?? r.text?.content ?? '';
    const a = r.annotations || {};
    if (a.code) t = wrap(t, '`');
    if (a.bold) t = wrap(t, '**');
    if (a.italic) t = wrap(t, '*');
    if (a.strikethrough) t = wrap(t, '~~');
    const href = r.href ?? r.text?.link?.url;
    if (href && t.trim()) t = `[${t}](${href})`;
    return t;
  }).join('');
}

const indentLines = (s, indent) => (indent ? s.split('\n').map(l => indent + l).join('\n') : s);

function fileUrl(v) {
  return v.type === 'external' ? v.external?.url : v.file?.url;
}

function tableToMd(b) {
  const rows = (b.children ?? b.table.children ?? []).filter(r => r.type === 'table_row');
  if (!rows.length) return '';
  const lines = rows.map(r => '| ' + r.table_row.cells
    .map(c => richTextToMd(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))
    .join(' | ') + ' |');
  lines.splice(1, 0, '|' + ' --- |'.repeat(rows[0].table_row.cells.length));
  return lines.join('\n');
}

// Recebe blocos já com `children` resolvidos (ver fetchChildren em notion.js).
export function blocksToMd(blocks = [], indent = '') {
  const parts = [];
  let num = 0;
  for (const b of blocks) {
    const type = b.type;
    const v = b[type] || {};
    const text = richTextToMd(v.rich_text);
    const isList = LIST_TYPES.has(type);
    num = type === 'numbered_list_item' ? num + 1 : 0;
    let line = null;
    let childIndent = indent;
    let renderChildren = true;

    switch (type) {
      case 'paragraph': line = text || null; break;
      case 'heading_1': line = `# ${text}`; break;
      case 'heading_2': line = `## ${text}`; break;
      case 'heading_3': line = `### ${text}`; break;
      case 'bulleted_list_item': line = `- ${text}`; childIndent += '  '; break;
      case 'numbered_list_item': line = `${num}. ${text}`; childIndent += '   '; break;
      case 'to_do': line = `- [${v.checked ? 'x' : ' '}] ${text}`; childIndent += '  '; break;
      case 'toggle': line = `- ${text}`; childIndent += '  '; break;
      case 'quote': line = `> ${text.replace(/\n/g, '\n> ')}`; break;
      case 'callout': line = `> ${v.icon?.emoji ?? '💡'} ${text.replace(/\n/g, '\n> ')}`; break;
      case 'code': line = '```' + (v.language === 'plain text' ? '' : v.language || '') + '\n' + plainText(v.rich_text) + '\n```'; break;
      case 'divider': line = '---'; break;
      case 'equation': line = `$$\n${v.expression}\n$$`; break;
      case 'child_page': line = `📄 Subpágina: ${v.title} (id: ${b.id})`; break;
      case 'child_database': line = `🗃️ Banco de dados: ${v.title} (id: ${b.id})`; break;
      case 'link_to_page': line = `🔗 Link para ${v.page_id || v.database_id || v.data_source_id}`; break;
      case 'image': line = `![${plainText(v.caption) || 'imagem'}](${fileUrl(v)})`; break;
      case 'file': case 'pdf': case 'video': case 'audio':
        line = `[${type}: ${v.name || plainText(v.caption) || 'arquivo'}](${fileUrl(v)})`; break;
      case 'bookmark': case 'embed': case 'link_preview':
        line = `[${plainText(v.caption) || v.url}](${v.url})`; break;
      case 'table': line = tableToMd(b) || null; renderChildren = false; break;
      case 'column_list': case 'column': case 'synced_block': break; // só os filhos importam
      default: line = text || `[bloco não suportado: ${type}]`;
    }

    if (line !== null) parts.push({ text: indentLines(line, indent), list: isList });
    const children = b.children ?? v.children; // da API (fetchChildren) ou montado por mdToBlocks
    if (renderChildren && children?.length) {
      const inner = blocksToMd(children, childIndent);
      if (inner) parts.push({ text: inner, list: isList });
    }
  }
  // Itens de lista seguidos ficam colados; os demais blocos são separados por linha em branco.
  return parts.reduce((acc, p, i) => (i === 0 ? p.text : acc + (p.list && parts[i - 1].list ? '\n' : '\n\n') + p.text), '');
}

// ---------- Markdown → Notion ----------

function pushText(out, content, annotations = {}, url = null) {
  for (let i = 0; i < content.length; i += MAX_TEXT) {
    out.push({
      type: 'text',
      text: { content: content.slice(i, i + MAX_TEXT), link: url ? { url } : null },
      annotations: { ...annotations },
    });
  }
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|~~(.+?)~~|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?!\w)/g;

export function mdToRichText(text = '') {
  const out = [];
  const s = String(text);
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) pushText(out, s.slice(last, m.index));
    if (m[1] !== undefined) pushText(out, m[1], { code: true });
    else if (m[2] !== undefined || m[3] !== undefined) pushText(out, m[2] ?? m[3], { bold: true });
    else if (m[4] !== undefined) pushText(out, m[4], {}, m[5]);
    else if (m[6] !== undefined) pushText(out, m[6], { strikethrough: true });
    else pushText(out, m[7] ?? m[8], { italic: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) pushText(out, s.slice(last));
  return out;
}

function codeLanguage(lang) {
  const l = (lang || '').toLowerCase();
  const mapped = LANG_ALIASES[l] ?? l;
  return CODE_LANGS.has(mapped) ? mapped : 'plain text';
}

const block = (type, payload) => ({ object: 'block', type, [type]: payload });
const textBlock = (type, text, extra = {}) => block(type, { rich_text: mdToRichText(text), ...extra });

const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

function tableBlock(rows) {
  const isSeparator = r => r.every(c => /^:?-{2,}:?$/.test(c));
  const hasHeader = rows.length > 1 && isSeparator(rows[1]);
  const data = rows.filter(r => !isSeparator(r));
  const width = Math.max(...data.map(r => r.length));
  return block('table', {
    table_width: width,
    has_column_header: hasHeader,
    has_row_header: false,
    children: data.map(r => block('table_row', {
      cells: Array.from({ length: width }, (_, i) => mdToRichText(r[i] ?? '')),
    })),
  });
}

export function mdToBlocks(md = '') {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let stack = []; // itens de lista abertos: { indent, block, depth, container }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
    if (fence) {
      const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      const rich = [];
      pushText(rich, body.join('\n'));
      blocks.push(block('code', { rich_text: rich, language: codeLanguage(fence[2]) }));
      stack = [];
      continue;
    }

    if (!line.trim()) continue;

    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      i--;
      blocks.push(tableBlock(rows));
      stack = [];
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(block('divider', {}));
      stack = [];
      continue;
    }

    let m;
    let item = null;
    if ((m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/))) item = textBlock('to_do', m[2], { checked: m[1] !== ' ' });
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) item = textBlock('bulleted_list_item', m[1]);
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) item = textBlock('numbered_list_item', m[1]);

    if (item) {
      const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      let container = blocks;
      let depth = 0;
      if (parent && parent.depth < MAX_NESTING) {
        const payload = parent.block[parent.block.type];
        container = payload.children ||= [];
        depth = parent.depth + 1;
      } else if (parent) {
        // Mais fundo do que a API aceita: vira irmão do item pai.
        container = parent.container;
        depth = parent.depth;
      }
      container.push(item);
      stack.push({ indent, block: item, depth, container });
      continue;
    }

    stack = [];
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) blocks.push(textBlock(`heading_${Math.min(m[1].length, 3)}`, m[2]));
    else if ((m = line.match(/^\s*>\s?(.*)$/))) blocks.push(textBlock('quote', m[1]));
    else if ((m = line.match(/^\s*!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*$/))) {
      blocks.push(block('image', { type: 'external', external: { url: m[2] }, caption: mdToRichText(m[1]) }));
    } else blocks.push(textBlock('paragraph', line.trim()));
  }
  return blocks;
}
