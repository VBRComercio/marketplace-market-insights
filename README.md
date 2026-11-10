# Marketplace Market Insights

Painel de pesquisa e análise de mercado para o Mercado Livre. Pesquisa anúncios reais do site brasileiro (MLB), compara preços e apresenta ofertas públicas relacionadas à busca.

## Funcionalidades

- Busca por palavra-chave na API do Mercado Livre.
- Indicadores de preço médio, menor preço, maior preço e quantidade de anúncios retornados.
- Lista com título, preço, condição, vendedor e link para cada anúncio.
- Interface responsiva em português.
- Cloudflare Pages Function como intermediária da API.

> Os indicadores descrevem os anúncios retornados no momento da consulta. Não representam previsão de demanda, vendas ou margem. A API pode limitar ou alterar os dados retornados.

## Tecnologias

HTML, CSS e JavaScript sem framework; Cloudflare Pages Functions; API do Mercado Livre.

## Rodar localmente

Requer Node.js e Wrangler:

```bash
npm install --global wrangler
wrangler pages dev .
```

Abra o endereço local informado pelo Wrangler. A função `functions/api/search.js` atende `/api/search?q=termo`.

## Publicar no Cloudflare Pages

1. Conecte este repositório ao Cloudflare Pages.
2. Configure a pasta de saída como `/`; não é necessário comando de build.
3. Faça o primeiro deploy e acesse a URL `*.pages.dev` gerada.

A pesquisa de anúncios públicos deste MVP não precisa do Client Secret OAuth. Se uma etapa futura usar dados privados da conta ou endpoints que exijam autorização, configure OAuth e os segredos somente no servidor, nunca no JavaScript do navegador.

## Segurança e dados

Não coloque Client Secret, access token ou refresh token no repositório. A aplicação consulta resultados públicos de busca e não altera anúncios nem dados da conta.
