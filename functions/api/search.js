import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const MAX_RESULTS = 50;
const PRICE_LOOKUP_BATCH_SIZE = 10;

export async function onRequestGet(context) {
  try {
    return await handleSearch(context);
  } catch {
    return json({ error: "Falha interna ao processar a busca. A função do Cloudflare retornou uma resposta inesperada; tente novamente após a implantação." }, 500);
  }
}

async function handleSearch({ request, env }) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2 || query.length > 100) {
    return json({ error: "Informe uma busca entre 2 e 100 caracteres." }, 400);
  }

  let session = await readSession(request, env);
  if (!session) {
    return json({ error: "Conecte sua conta do Mercado Livre para autorizar a pesquisa.", login_url: "/auth/login" }, 401);
  }

  let refreshed = false;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) {
      return json({ error: "A autorização expirou. Conecte sua conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() });
    }
    refreshed = true;
  }

  const authorizedFetch = async (url) => {
    let response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + session.access_token,
        "User-Agent": "MarketplaceMarketInsights/1.0"
      }
    });
    if (response.status === 401 && !refreshed) {
      const nextSession = await refreshSession(session, env);
      if (nextSession) {
        session = nextSession;
        refreshed = true;
        response = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + session.access_token,
            "User-Agent": "MarketplaceMarketInsights/1.0"
          }
        });
      }
    }
    return response;
  };

  const upstream = new URL(API_BASE + "/sites/MLB/search");
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("limit", String(MAX_RESULTS));
  upstream.searchParams.set("sort", "relevance");

  try {
    const response = await authorizedFetch(upstream);
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    if (response.status === 401) {
      return json({ error: "O Mercado Livre rejeitou a autorização. Atualize a conexão da conta e tente novamente.", login_url: "/auth/login" }, 401, { ...headers, "Set-Cookie": clearSessionCookie() });
    }
    if (!response.ok) {
      if (response.status === 429) return json({ error: "O Mercado Livre limitou temporariamente as consultas. Aguarde um pouco e tente novamente." }, 429, headers);
      const apiError = await response.json().catch(() => null);
      const detail = describeApiError(apiError);
      const suffix = detail ? " Detalhe informado pela API: " + detail : "";
      return json({
        error: "A API do Mercado Livre respondeu com erro (" + response.status + ")." + suffix,
        upstream_status: response.status,
        request_id: response.headers.get("x-request-id"),
        api_date: response.headers.get("date")
      }, 502, headers);
    }

    const raw = await response.json();
    const rawItems = Array.isArray(raw.results) ? raw.results : [];
    const results = [];
    for (let i = 0; i < rawItems.length; i += PRICE_LOOKUP_BATCH_SIZE) {
      const group = rawItems.slice(i, i + PRICE_LOOKUP_BATCH_SIZE);
      const pricedGroup = await Promise.all(group.map(async (item) => {
        const sale = item.id ? await fetchSalePrice(item.id, authorizedFetch) : null;
        const saleAmount = finiteAmount(sale?.amount);
        const regularAmount = finiteAmount(sale?.regular_amount) ?? finiteAmount(item.original_price);
        const currentAmount = saleAmount ?? finiteAmount(item.price);
        return {
          id: item.id,
          title: item.title,
          price: currentAmount,
          regular_price: regularAmount,
          is_promotional: currentAmount !== null && regularAmount !== null && regularAmount > currentAmount,
          price_source: saleAmount === null ? "search" : "sale_price",
          currency_id: sale?.currency_id || item.currency_id,
          condition: item.condition,
          thumbnail: item.thumbnail,
          permalink: item.permalink,
          seller: item.seller ? { id: item.seller.id } : null,
          category_id: item.category_id
        };
      }));
      results.push(...pricedGroup);
    }

    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({
      query,
      site: "MLB",
      pricing_context: "channel_marketplace",
      paging: { total: raw.paging?.total ?? results.length, limit: MAX_RESULTS },
      results
    }, 200, headers);
  } catch {
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ error: "Não foi possível conectar à API do Mercado Livre. Tente novamente." }, 502, headers);
  }
}

async function fetchSalePrice(itemId, authorizedFetch) {
  try {
    const url = new URL(API_BASE + "/items/" + encodeURIComponent(itemId) + "/sale_price");
    url.searchParams.set("context", "channel_marketplace");
    const response = await authorizedFetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function finiteAmount(value) {
  const amount = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(amount) ? amount : null;
}

function describeApiError(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  for (const key of ["error", "code", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  if (Array.isArray(payload.cause)) {
    for (const cause of payload.cause.slice(0, 2)) {
      if (cause && typeof cause === "object") {
        const code = typeof cause.code === "string" ? cause.code.trim() : "";
        const message = typeof cause.message === "string" ? cause.message.trim() : "";
        if (code || message) parts.push([code, message].filter(Boolean).join(": "));
      }
    }
  }
  return [...new Set(parts)].join(" — ").replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

async function refreshSession(session, env) {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) return null;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      refresh_token: session.refresh_token
    });
    const response = await fetch(API_BASE + "/oauth/token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await response.json();
    if (!response.ok || !tokens.access_token || !tokens.refresh_token) return null;
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + Number(tokens.expires_in || 21600) * 1000
    };
  } catch {
    return null;
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }
  });
}
