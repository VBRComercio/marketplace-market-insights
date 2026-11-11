import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 8;

export async function onRequestGet({ request, env }) {
  try {
    return await handleRequest(request, env);
  } catch {
    return json({ error: "Falha interna ao continuar a consulta dos pedidos." }, 500);
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const days = Number.parseInt(url.searchParams.get("days") || "7", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const dateFrom = parseDate(url.searchParams.get("date_from"));
  const dateTo = parseDate(url.searchParams.get("date_to"));
  if (![7, 30, 90].includes(days)) return json({ error: "Escolha um período de 7, 30 ou 90 dias." }, 400);
  if (!Number.isInteger(offset) || offset < 50 || offset % PAGE_SIZE !== 0 || offset > 10000) {
    return json({ error: "Deslocamento de pedidos inválido." }, 400);
  }
  if (!dateFrom || !dateTo || dateTo <= dateFrom || dateTo - dateFrom > 92 * 86_400_000) {
    return json({ error: "Intervalo de datas inválido para esta consulta." }, 400);
  }

  let session = await readSession(request, env);
  if (!session) return json({ error: "Conecte sua conta do Mercado Livre para consultar os pedidos.", login_url: "/auth/login" }, 401);

  let refreshed = false;
  let refreshPromise = null;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) return json({ error: "A autorização expirou. Conecte a conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() });
    refreshed = true;
  }

  const requestApi = async (target) => {
    const tokenUsed = session.access_token;
    let response = await fetch(API_BASE + target, {
      headers: { Accept: "application/json", Authorization: "Bearer " + tokenUsed }
    });
    if (response.status === 401) {
      if (!refreshPromise && !refreshed) refreshPromise = refreshSession(session, env);
      const nextSession = refreshPromise ? await refreshPromise : null;
      if (nextSession) {
        session = nextSession;
        refreshed = true;
        refreshPromise = null;
      }
      if (session.access_token !== tokenUsed) {
        response = await fetch(API_BASE + target, {
          headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token }
        });
      }
    }
    return response;
  };

  const meResponse = await requestApi("/users/me");
  if (!meResponse.ok) return upstreamError(meResponse, "Não foi possível confirmar a conta do Mercado Livre.", refreshed ? await sessionCookie(session, env) : null);
  const me = await meResponse.json();
  if (!me.id) return json({ error: "O Mercado Livre não retornou o ID do vendedor." }, 502);

  const ordersUrl = new URL(API_BASE + "/orders/search");
  ordersUrl.searchParams.set("seller", String(me.id));
  ordersUrl.searchParams.set("order.status", "paid");
  ordersUrl.searchParams.set("order.date_created.from", formatOrdersDate(dateFrom));
  ordersUrl.searchParams.set("order.date_created.to", formatOrdersDate(dateTo));
  ordersUrl.searchParams.set("sort", "date_desc");
  ordersUrl.searchParams.set("limit", String(PAGE_SIZE));

  const salesByItem = {};
  let total = 0;
  let scanned = 0;
  let error = null;
  const pages = MAX_PAGES;
  try {
    for (let page = 0; page < pages; page++) {
      ordersUrl.searchParams.set("offset", String(offset + page * PAGE_SIZE));
      const response = await requestApi(ordersUrl.pathname + ordersUrl.search);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        error = safeApiMessage(payload) || "A API não autorizou a consulta de pedidos.";
        return json({
          error: "Não foi possível completar a consulta de pedidos. " + error,
          upstream_status: response.status,
          request_id: response.headers.get("x-request-id"),
          api_date: response.headers.get("date")
        }, 502, refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {});
      }
      const payload = await response.json();
      const results = Array.isArray(payload.results) ? payload.results : [];
      total = Number(payload.paging?.total ?? total);
      scanned += results.length;
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
      if (!results.length || offset + scanned >= total) break;
    }
  } catch {
    return json({ error: "Não foi possível conectar ao Mercado Livre durante a consulta de pedidos." }, 502);
  }

  const nextOffset = offset + scanned < total ? offset + scanned : null;
  const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
  return json({
    seller: { id: me.id, nickname: me.nickname || null },
    sales_by_item: salesByItem,
    orders: { scanned, total, next_offset: nextOffset, partial: nextOffset !== null },
    date_from: dateFrom.toISOString(),
    date_to: dateTo.toISOString()
  }, 200, headers);
}

function parseDate(value) {
  if (!value || value.length > 40) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatOrdersDate(date) {
  return date.toISOString().replace(/Z$/, "-00:00");
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
