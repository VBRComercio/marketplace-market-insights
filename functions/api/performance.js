import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const PAGE_SIZE = 50;
const MAX_VISIT_LOOKUPS = 45;
const MAX_ORDER_PAGES = 8;
const ORDER_PAGE_SIZE = 50;

export async function onRequestGet({ request, env }) {
  try {
    return await handleRequest(request, env);
  } catch {
    return json({ error: "Falha interna ao consultar o desempenho dos anúncios." }, 500);
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const days = Number.parseInt(url.searchParams.get("days") || "7", 10);
  if (!Number.isInteger(offset) || offset < 0 || offset > 950 || offset % PAGE_SIZE !== 0) {
    return json({ error: "Página inválida. Use um deslocamento em incrementos de 50." }, 400);
  }
  if (![7, 30, 90].includes(days)) {
    return json({ error: "Escolha um período de 7, 30 ou 90 dias." }, 400);
  }

  let session = await readSession(request, env);
  if (!session) return json({ error: "Conecte sua conta do Mercado Livre para consultar o desempenho.", login_url: "/auth/login" }, 401);

  let refreshed = false;
  let refreshPromise = null;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) return json({ error: "A autorização expirou. Conecte sua conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() });
    refreshed = true;
  }

  const requestApi = async (target) => {
    const url = target.startsWith("http") ? target : API_BASE + target;
    let response = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
    if (response.status === 401) {
      if (!refreshPromise && !refreshed) refreshPromise = refreshSession(session, env);
      const nextSession = refreshPromise ? await refreshPromise : null;
      if (nextSession) {
        session = nextSession;
        refreshed = true;
        refreshPromise = null;
        response = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
      }
    }
    return response;
  };

  const meResponse = await requestApi("/users/me");
  if (!meResponse.ok) return upstreamError(meResponse, "Não foi possível confirmar a conta do Mercado Livre.", refreshed ? await sessionCookie(session, env) : null);
  const me = await meResponse.json();
  if (!me.id) return json({ error: "O Mercado Livre não retornou o ID do vendedor." }, 502);

  const itemsUrl = new URL(API_BASE + "/users/" + encodeURIComponent(me.id) + "/items/search");
  itemsUrl.searchParams.set("status", "active");
  itemsUrl.searchParams.set("limit", String(PAGE_SIZE));
  itemsUrl.searchParams.set("offset", String(offset));
  const itemsResponse = await requestApi(itemsUrl.pathname + itemsUrl.search);
  if (!itemsResponse.ok) return upstreamError(itemsResponse, "Não foi possível listar os anúncios ativos.", refreshed ? await sessionCookie(session, env) : null);
  const itemSearch = await itemsResponse.json();
  const itemIds = Array.isArray(itemSearch.results) ? itemSearch.results : [];
  const visitIds = itemIds.slice(0, MAX_VISIT_LOOKUPS);
  const ending = new Date().toISOString().slice(0, 10);
  let dateFrom = new Date(Date.now() - days * 86_400_000).toISOString();
  let dateTo = new Date().toISOString();

  const visits = {};
  const visitFailures = [];
  const visitRequests = visitIds.map(async (itemId) => {
    const visitUrl = new URL(API_BASE + "/items/" + encodeURIComponent(itemId) + "/visits/time_window");
    visitUrl.searchParams.set("last", String(days));
    visitUrl.searchParams.set("unit", "day");
    visitUrl.searchParams.set("ending", ending);
    try {
      const response = await requestApi(visitUrl.pathname + visitUrl.search);
      if (!response.ok) {
        visitFailures.push(response.status);
        visits[itemId] = null;
        return;
      }
      const payload = await response.json();
      visits[itemId] = finiteAmount(payload.total_visits);
      if (payload.date_from) dateFrom = payload.date_from;
      if (payload.date_to) dateTo = payload.date_to;
    } catch {
      visits[itemId] = null;
      visitFailures.push(0);
    }
  });

  const ordersUrl = new URL(API_BASE + "/orders/search");
  const isoStartFallback = new Date(Date.now() - days * 86_400_000).toISOString();
  ordersUrl.searchParams.set("seller", String(me.id));
  ordersUrl.searchParams.set("order.status", "paid");
  ordersUrl.searchParams.set("order.date_created.from", isoStartFallback);
  ordersUrl.searchParams.set("order.date_created.to", dateTo);
  ordersUrl.searchParams.set("sort", "date_desc");
  ordersUrl.searchParams.set("limit", String(ORDER_PAGE_SIZE));

  const salesByItem = {};
  let ordersScanned = 0;
  let ordersTotal = null;
  let salesError = null;
  let ordersPartial = false;
  const orderPages = Math.min(MAX_ORDER_PAGES, Math.max(1, 48 - visitIds.length - 2));

  try {
    for (let page = 0; page < orderPages; page++) {
      ordersUrl.searchParams.set("offset", String(page * ORDER_PAGE_SIZE));
      const response = await requestApi(ordersUrl.pathname + ordersUrl.search);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        salesError = safeApiMessage(payload) || "A API não autorizou a consulta de pedidos.";
        break;
      }
      const payload = await response.json();
      const results = Array.isArray(payload.results) ? payload.results : [];
      ordersTotal = Number(payload.paging?.total ?? results.length);
      ordersScanned += results.length;
      for (const order of results) {
        if (order.status !== "paid" || (Array.isArray(order.tags) && order.tags.includes("cancelled"))) continue;
        for (const line of order.order_items || []) {
          const itemId = line.item?.id;
          if (!itemId) continue;
          const quantity = finiteAmount(line.quantity) || 0;
          const unitPrice = finiteAmount(line.unit_price) ?? finiteAmount(line.full_unit_price) ?? 0;
          if (!salesByItem[itemId]) salesByItem[itemId] = { units: 0, gross: 0 };
          salesByItem[itemId].units += quantity;
          salesByItem[itemId].gross += quantity * unitPrice;
        }
      }
      if (!results.length || (ordersTotal !== null && ordersScanned >= ordersTotal)) break;
      if (page === orderPages - 1) ordersPartial = true;
    }
    if (ordersTotal !== null && ordersScanned < ordersTotal) ordersPartial = true;
  } catch {
    salesError = "Não foi possível consultar pedidos agora.";
  }

  await Promise.all(visitRequests);
  const items = itemIds.map((id) => {
    const sales = salesByItem[id] || { units: 0, gross: 0 };
    return { id, visits: visits[id] ?? null, units_sold: sales.units, gross_sales: Math.round(sales.gross * 100) / 100 };
  });
  const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
  return json({
    seller: { id: me.id, nickname: me.nickname || null },
    days,
    date_from: dateFrom,
    date_to: dateTo,
    items,
    totals: {
      visits: items.reduce((sum, item) => sum + (item.visits ?? 0), 0),
      units_sold: items.reduce((sum, item) => sum + item.units_sold, 0),
      gross_sales: Math.round(items.reduce((sum, item) => sum + item.gross_sales, 0) * 100) / 100
    },
    orders: { scanned: ordersScanned, total: ordersTotal, partial: ordersPartial },
    visits_partial: itemIds.length > visitIds.length || visitFailures.length > 0,
    visits_unavailable_count: itemIds.length - Object.values(visits).filter((value) => value !== null).length,
    sales_error: salesError,
    visits_error: visitFailures.length ? "A API não retornou visitas para " + visitFailures.length + " anúncio(s)." : null
  }, 200, headers);
}

function finiteAmount(value) {
  const amount = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(amount) ? amount : null;
}

function safeApiMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  return [payload.message, payload.error, payload.code]
    .find((value) => typeof value === "string" && value.trim())?.trim().slice(0, 200) || "";
}

async function upstreamError(response, fallback, cookie) {
  const payload = await response.json().catch(() => null);
  const detail = safeApiMessage(payload);
  const headers = cookie ? { "Set-Cookie": cookie } : {};
  return json({
    error: fallback + (detail ? " Detalhe informado pela API: " + detail : ""),
    upstream_status: response.status,
    request_id: response.headers.get("x-request-id"),
    api_date: response.headers.get("date")
  }, 502, headers);
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
