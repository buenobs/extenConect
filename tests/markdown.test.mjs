import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocksToMd, mdToBlocks, mdToRichText } from '../src/markdown.js';
import { normalizeId } from '../src/notion.js';

const ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const UUID = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

test('normalizeId aceita UUID, hex puro e URLs do Notion', () => {
  assert.equal(normalizeId(ID), UUID);
  assert.equal(normalizeId(UUID), UUID);
  assert.equal(normalizeId(`https://www.notion.so/equipe/Plano-de-Trabalho-${ID}?pvs=4`), UUID);
  assert.equal(normalizeId(`https://www.notion.so/equipe/abc?v=ffffffffffffffffffffffffffffffff&p=${ID}&pm=s`), UUID);
  assert.throws(() => normalizeId('nada-aqui'));
});

test('mdToRichText reconhece negrito, itálico, código, link e tachado', () => {
  const rt = mdToRichText('a **b** *c* `d` [e](https://x.com) ~~f~~ snake_case_name');
  const pick = rt.map(r => [r.text.content, Object.keys(r.annotations)[0] ?? (r.text.link ? 'link' : '')]);
  assert.deepEqual(pick, [
    ['a ', ''], ['b', 'bold'], [' ', ''], ['c', 'italic'], [' ', ''], ['d', 'code'], [' ', ''],
    ['e', 'link'], [' ', ''], ['f', 'strikethrough'], [' snake_case_name', ''],
  ]);
});

test('mdToRichText divide textos maiores que 2000 caracteres', () => {
  const rt = mdToRichText('x'.repeat(4500));
  assert.deepEqual(rt.map(r => r.text.content.length), [2000, 2000, 500]);
});

test('mdToBlocks converte títulos, listas aninhadas, tarefas, código, tabela e divisória', () => {
  const md = [
    '# Título', 'Texto', '- item', '  - sub', '    - subsub', '      - fundo demais', '- [x] feito',
    '1. um', '---', '```py', 'print(1)', '```', '| A | B |', '| --- | --- |', '| 1 | 2 |', '> citação',
  ].join('\n');
  const blocks = mdToBlocks(md);
  assert.deepEqual(blocks.map(b => b.type), [
    'heading_1', 'paragraph', 'bulleted_list_item', 'to_do', 'numbered_list_item', 'divider', 'code', 'table', 'quote',
  ]);
  const sub = blocks[2].bulleted_list_item.children[0];
  const subsub = sub.bulleted_list_item.children;
  assert.equal(subsub.length, 2, 'item além do limite vira irmão no nível 2');
  assert.equal(subsub[1].bulleted_list_item.children, undefined);
  assert.equal(blocks[3].to_do.checked, true);
  assert.equal(blocks[6].code.language, 'python');
  assert.equal(blocks[7].table.table_width, 2);
  assert.equal(blocks[7].table.has_column_header, true);
  assert.equal(blocks[7].table.children.length, 2);
});

test('blocksToMd faz o caminho de volta', () => {
  const md = blocksToMd(mdToBlocks('## Seção\n\nParágrafo com **negrito**\n\n- a\n  - b\n- c\n\n```js\nx()\n```'));
  assert.equal(md, '## Seção\n\nParágrafo com **negrito**\n\n- a\n  - b\n- c\n\n```javascript\nx()\n```');
});
