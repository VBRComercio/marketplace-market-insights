const API_BASE = "https://api.mercadolibre.com";
const MAX_RESULTS = 50;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search") {
      if (request.method !== "GET") {
        return json({ error: "Método não permitido." }, 405, { Allow: "GET" });
      }
      return searchListings(url.searchParams.get("q"));
    }

    return env.ASSETS.fetch(request);
  }
};

async function searchListings(rawQuery) {
  const query = (rawQuery || "").trim();
  if (query.length < 2 || query.length > 100) {
    return json({ error: "Informe uma busca entre 2 e 100 caracteres." }, 400);
  }

  const upstream = new URL(`${API_BASE}/sites/MLB/search`);
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("limit", String(MAX_RESULTS));
  upstream.searchParams.set("sort", "relevance");

  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json", "User-Agent": "MarketplaceMarketInsights/1.0" }
    });
    if (!response.ok) {
      if (response.status === 429) {
        return json({ error: "O Mercado Livre limitou temporariamente as consultas. Aguarde um pouco e tente novamente." }, 429);
      }
      return json({ error: `A API do Mercado Livre respondeu com erro (${response.status}). Tente novamente mais tarde.` }, 502);
    }

    const raw = await response.json();
    const results = (Array.isArray(raw.results) ? raw.results : []).map((item) => ({
      id: item.id,
      title: item.title,
      price: item.price,
      currency_id: item.currency_id,
      condition: item.condition,
      thumbnail: item.thumbnail,
      permalink: item.permalink,
      seller: item.seller ? { id: item.seller.id } : null,
      category_id: item.category_id
    }));

    return json({
      query,
      site: "MLB",
      paging: { total: raw.paging?.total ?? results.length, limit: MAX_RESULTS },
      results
    }, 200, { "Cache-Control": "public, max-age=30, s-maxage=30" });
  } catch {
    return json({ error: "Não foi possível conectar à API do Mercado Livre. Tente novamente." }, 502);
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }
  });
}
