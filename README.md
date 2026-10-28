# Conector Notion para IAs

Extensão do Chrome (Manifest V3) que dá a **qualquer IA aberta no navegador** (ChatGPT, Claude, Gemini, DeepSeek, Perplexity, Copilot, Grok, Mistral…) acesso ao seu Notion. Não depende de API nem de MCP do provedor da IA: a extensão conversa com o Notion e com a página do chat.

## Como funciona

1. **Painel** (botão “N” flutuante ou `Ctrl+Shift+Y`)
   - **Buscar**: procura páginas e bancos e insere o conteúdo deles, em Markdown, na caixa de mensagem da IA.
   - **Salvar**: cria uma página no Notion com o texto selecionado ou o que você escrever.
   - **IA**: botão **Ensinar a IA**, que insere no chat as instruções do protocolo abaixo.
2. **Protocolo de ferramentas**: depois de “ensinada”, a IA responde com um bloco de código como este:

   ```json
   {"notion_tool": "search", "query": "roadmap"}
   ```

   A extensão detecta o bloco e põe um botão **Executar** logo abaixo. Ao clicar, ela roda o comando no Notion e cola `NOTION_RESULT …` na caixa de mensagem. Você envia, e a IA continua a partir dali.
   - Ferramentas: `search`, `read_page`, `query_database`, `create_page`, `append_to_page`.
   - Leituras podem rodar sozinhas (opção “Executar leituras automaticamente”), com um limite de 10 execuções a cada 5 minutos para evitar loops.
   - **Escritas (`create_page`, `append_to_page`) sempre pedem confirmação**, mostrando o comando completo.
   - Comandos que já estavam na conversa quando ela foi aberta não rodam sozinhos.

## Instalação

1. Gere os ícones (já estão em `icons/`; só precisa refazer se mudar o desenho): `npm run icons`
2. Abra `chrome://extensions`, ative o **Modo do desenvolvedor** e clique em **Carregar sem compactação**, escolhendo esta pasta.
3. A página de opções abre sozinha. Nela:
   - Crie uma integração **interna** em [notion.so/profile/integrations](https://www.notion.so/profile/integrations) com permissão de ler, atualizar e inserir conteúdo.
   - Cole o token (`ntn_…`) e clique em **Testar**.
   - No Notion, em cada página ou banco que a IA pode usar: **•••** › **Conexões** › adicione a integração. Subpáginas herdam o acesso.
4. Abra o site da sua IA. O botão “N” aparece no canto direito.

**Outros sites de IA:** clique no ícone da extensão › **Abrir painel nesta aba** (funciona em qualquer site), ou ative o domínio na seção “Outros sites de IA” das opções para o painel carregar sempre.

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `manifest.json` | Permissões, sites de IA conhecidos e atalho de teclado |
| `src/background.js` | Service worker: executa as ferramentas e formata os resultados para a IA |
| `src/notion.js` | Cliente da API do Notion (versão `2025-09-03`, com fontes de dados) |
| `src/markdown.js` | Conversão entre blocos do Notion e Markdown |
| `src/content.js` | Painel, detecção dos comandos `notion_tool` e inserção no chat |
| `popup/`, `options/` | Popup do ícone e página de opções |

## Desenvolvimento

```bash
npm test
```

```bash
npm run check
```

Depois de editar, recarregue a extensão em `chrome://extensions` e atualize a aba da IA.

## Limitações conhecidas

- A inserção no chat e o envio automático usam seletores genéricos. Se um site mudar o layout, o texto é copiado para a área de transferência como alternativa.
- A leitura de páginas vai até 3 níveis de aninhamento e 1.500 blocos.
- Ao escrever, listas com mais de 3 níveis são achatadas, porque a API aceita no máximo 2 níveis de filhos por requisição.
- O token fica em `chrome.storage.local`, só neste navegador e sem sincronização.
- Tudo o que é inserido no chat vai para o provedor daquela IA. Compartilhe com a integração apenas o que você aceita enviar.
