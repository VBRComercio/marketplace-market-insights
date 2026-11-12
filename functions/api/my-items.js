import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const PAGE_SIZE = 50;
const BULK_SIZE = 20;
const PRICE_LOOKUP_BATCH_SIZE = 10;

export async function onRequestGet({ request, env }) {
  try {
    return await handleRequest(request, env);
  } catch {
    return json({ error: "Falha interna ao carregar seus anúncios." }, 500);
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const priceOffset = Number.parseInt(url.searchParams.get("price_offset") || "0", 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > 950 || offset % PAGE_SIZE !== 0) {
    return json({ error: "Página inválida. Use um deslocamento em incrementos de 50." }, 400);
  }

  if (!Number.isInteger(priceOffset) || priceOffset < 0 || priceOffset > 40 || priceOffset % PRICE_LOOKUP_BATCH_SIZE !== 0) {
    return json({ error: "Lote de preços inválido." }, 400);
  }

  let session = await readSession(request, env);
  if (!session) {
    return json({ error: "Conecte sua conta do Mercado Livre para consultar seus anúncios.", login_url: "/auth/login" }, 401);
  }

  let refreshed = false;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) {
      return json({ error: "A autorização expirou. Conecte sua conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() });
    }
    refreshed = true;
  }

  const requestApi = async (path) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let response = await fetch(API_BASE + path, {
          headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token }
        });
        if (response.status === 401 && !refreshed) {
          const nextSession = await refreshSession(session, env);
          if (nextSession) {
            session = nextSession;
            refreshed = true;
            response = await fetch(API_BASE + path, {
              headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token }
            });
          }
        }
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return response;
        await waitBeforeRetry(response, attempt);
      } catch (error) {
        if (attempt === 2) throw error;
        await waitBeforeRetry(null, attempt);
      }
    }
    throw new Error("A API não respondeu após novas tentativas.");
  };

  const meResponse = await requestApi("/users/me");
  if (!meResponse.ok) {
    return upstreamError(meResponse, "Não foi possível confirmar sua conta no Mercado Livre.", refreshed ? await sessionCookie(session, env) : null);
  }
  const me = await meResponse.json();
  if (!me.id) return json({ error: "O Mercado Livre não retornou o ID do vendedor." }, 502);

  const searchUrl = new URL(API_BASE + "/users/" + encodeURIComponent(me.id) + "/items/search");
  searchUrl.searchParams.set("status", "active");
  searchUrl.searchParams.set("limit", String(PAGE_SIZE));
  searchUrl.searchParams.set("offset", String(offset));
  const searchResponse = await requestApi(searchUrl.pathname + searchUrl.search);
  if (!searchResponse.ok) {
    return upstreamError(searchResponse, "Não foi possível listar os anúncios ativos da sua conta.", refreshed ? await sessionCookie(session, env) : null);
  }

  const search = await searchResponse.json();
  const ids = Array.isArray(search.results) ? search.results : [];
  const itemGroups = [];
  for (let i = 0; i < ids.length; i += BULK_SIZE) itemGroups.push(ids.slice(i, i + BULK_SIZE));

  const detailResponses = await Promise.all(itemGroups.map(async (group) => {
    const bulkUrl = new URL(API_BASE + "/items/bulk");
    bulkUrl.searchParams.set("ids", group.join(","));
    const response = await requestApi(bulkUrl.pathname + bulkUrl.search);
    if (!response.ok) return { failed: true, response };
    const payload = await response.json();
    const entries = Array.isArray(payload) ? payload : payload.results || [];
    return {
      items: entries
        .filter((entry) => (entry.status_code ?? entry.code ?? 200) < 300)
        .map((entry) => entry.body || entry.item || entry)
    };
  }));

  const failedGroup = detailResponses.find((group) => group.failed);
  if (failedGroup) {
    return upstreamError(failedGroup.response, "A lista foi encontrada, mas o Mercado Livre não retornou os detalhes dos anúncios.", refreshed ? await sessionCookie(session, env) : null);
  }

  const byId = new Map();
  for (const group of detailResponses) {
    for (const item of group.items || []) {
      if (item && item.id) {
        byId.set(item.id, {
          id: item.id,
          title: item.title || "Anúncio sem título",
          standard_price: item.price ?? null,
          price: null,
          regular_price: null,
          is_promotional: false,
          price_source: "unavailable",
          currency_id: item.currency_id || "BRL",
          status: item.status || "active",
          available_quantity: item.available_quantity ?? null,
          condition: item.condition || null,
          listing_type_id: item.listing_type_id || null,
          seller_sku: item.seller_custom_field || item.attributes?.find((attribute) => attribute.id === "SELLER_SKU")?.value_name || null,
          shipping: {
            mode: item.shipping?.mode || null,
            logistic_type: item.shipping?.logistic_type || null,
            free_shipping: Boolean(item.shipping?.free_shipping)
          },
          thumbnail: item.thumbnail || null,
          permalink: item.permalink || null,
          category_id: item.category_id || null,
          last_updated: item.last_updated || null
        });
      }
    }
  }

  const itemDetails = ids.map((id) => byId.get(id)).filter(Boolean);
  let pricingUnavailable = 0;
  const pricingUnavailableStatuses = {};
  const recordPricingFailure = (reason) => {
    pricingUnavailable += 1;
    pricingUnavailableStatuses[reason] = (pricingUnavailableStatuses[reason] || 0) + 1;
  };
  const pricedItems = [];
  const selectedDetails = itemDetails.slice(priceOffset, priceOffset + PRICE_LOOKUP_BATCH_SIZE);
  for (let i = 0; i < selectedDetails.length; i += PRICE_LOOKUP_BATCH_SIZE) {
    const group = selectedDetails.slice(i, i + PRICE_LOOKUP_BATCH_SIZE);
    const prices = await Promise.all(group.map(async (item) => {
      const priceUrl = "/items/" + encodeURIComponent(item.id) + "/sale_price?context=channel_marketplace";
      try {
        const response = await requestApi(priceUrl);
        if (!response.ok) {
          recordPricingFailure("HTTP " + response.status);
          return item;
        }
        const sale = await response.json();
        const amount = finiteAmount(sale.amount);
        if (amount === null) {
          recordPricingFailure("resposta sem preço");
          return item;
        }
        const regularAmount = finiteAmount(sale.regular_amount);
        return {
          ...item,
          price: amount,
          regular_price: regularAmount,
          is_promotional: regularAmount !== null && regularAmount > amount,
          price_source: "sale_price",
          currency_id: sale.currency_id || item.currency_id
        };
      } catch {
        recordPricingFailure("conexão");
        return item;
      }
    }));
    pricedItems.push(...prices);
  }

  const pricedById = new Map(pricedItems.map((item) => [item.id, item]));
  const resultItems = itemDetails.map((item) => pricedById.get(item.id) || item);
  const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
  return json({
    seller: { id: me.id, nickname: me.nickname || null },
    pricing_context: "channel_marketplace",
    pricing_unavailable_count: pricingUnavailable,
    pricing_unavailable_statuses: pricingUnavailableStatuses,
    price_offset: priceOffset,
    items: resultItems,
    paging: {
      total: search.paging?.total ?? ids.length,
      limit: PAGE_SIZE,
      offset,
      has_more: offset + ids.length < (search.paging?.total ?? ids.length),
      scan_required: Number(search.paging?.total || 0) > 1000
    }
  }, 200, headers);
}

async function waitBeforeRetry(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2000, retryAfter * 1000) : (attempt === 0 ? 300 : 800);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
function finiteAmount(value) {
  const amount = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(amount) ? amount : null;
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

async function upstreamError(response, fallback, cookie) {
  const payload = await response.json().catch(() => null);
  const detail = payload && [payload.error, payload.message, payload.code].filter((part) => typeof part === "string" && part.trim()).join(" — ");
  const headers = cookie ? { "Set-Cookie": cookie } : {};
  return json({
    error: fallback + (detail ? " Detalhe: " + detail.slice(0, 200) : ""),
    upstream_status: response.status,
    request_id: response.headers.get("x-request-id"),
    api_date: response.headers.get("date")
  }, 502, headers);
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }
  });
}
