# Marketplace Market Insights

Painel de pesquisa e análise de mercado para o Mercado Livre. Pesquisa anúncios do site brasileiro (MLB), compara preços e apresenta ofertas relacionadas à busca, com OAuth para autorizar chamadas à API.

## Funcionalidades

- Busca por palavra-chave na API do Mercado Livre.
- Indicadores de preço médio, menor preço, maior preço e quantidade de anúncios retornados.
- Lista de anúncios com título, preço, condição, vendedor e link.
- OAuth Authorization Code com PKCE, validação de `state` e renovação automática de tokens.
- Sessão em cookie `HttpOnly`, `Secure` e criptografada no servidor.
- Interface responsiva e Cloudflare Pages Functions.

> Os indicadores descrevem os anúncios retornados no momento da consulta. Não representam previsão de demanda, vendas ou margem.

## Callback OAuth

Cadastre esta Redirect URI no aplicativo Mercado Livre, exatamente como aparece:

```
https://marketplace-market-insights.pages.dev/oauth/callback
```

## Configurar credenciais no Cloudflare

No projeto Pages, abra **Settings → Variables and Secrets** e adicione no ambiente **Production**:

- `ML_CLIENT_ID`: App ID do aplicativo Mercado Livre.
- `ML_CLIENT_SECRET`: Secret Key do aplicativo, como secret criptografado.

Não envie o Client Secret pelo chat nem o grave no GitHub. Após salvar as variáveis, faça um novo deploy.

## Publicação e desenvolvimento

O site está na raiz do repositório e as funções em `functions/`. Para Pages, use ramo `main`, comando de build `exit 0`, diretório de saída `.` e mantenha o diretório raiz vazio.

Para desenvolvimento local, instale Wrangler e execute `wrangler pages dev .`. A rota `/auth/login` inicia a autorização, `/oauth/callback` recebe o retorno e `/api/search?q=termo` pesquisa anúncios.

## Segurança

As chamadas à API são feitas no servidor com o access token. Access token e refresh token ficam em cookie criptografado `HttpOnly`, inacessível ao JavaScript do navegador. O Client Secret não deve ser publicado. O projeto não altera anúncios nem dados da conta.
