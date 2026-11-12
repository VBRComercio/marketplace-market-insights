import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const PAGE_SIZE = 50;
const MAX_VISIT_LOOKUPS = 30;
const VISIT_BATCH_SIZE = 20;
const API_REQUEST_BUDGET = 45;
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
  let days = Number.parseInt(url.searchParams.get("days") || "7", 10);
  const requestedFrom = url.searchParams.get("date_from");
  const visitsOnly = url.searchParams.get("visits_only") === "1";
  const requestedVisitOffset = Number.parseInt(url.searchParams.get("visits_offset") || "0", 10);
  if (!Number.isInteger(requestedVisitOffset) || requestedVisitOffset < 0 || requestedVisitOffset >= PAGE_SIZE) return json({ error: "Faixa de visitas inválida." }, 400);
  const requestedTo = url.searchParams.get("date_to");
  const customPeriod = Boolean(requestedFrom || requestedTo);
  if (!Number.isInteger(offset) || offset < 0 || offset > 950 || offset % PAGE_SIZE !== 0) {
    return json({ error: "Página inválida. Use um deslocamento em incrementos de 50." }, 400);
  }
  if (customPeriod) {
    const fromDay = parseDateOnly(requestedFrom);
    const toDay = parseDateOnly(requestedTo);
    if (!fromDay || !toDay || toDay < fromDay) return json({ error: "Informe um intervalo de datas válido." }, 400);
    days = Math.floor((toDay - fromDay) / 86_400_000) + 1;
    if (days > 90) return json({ error: "O período personalizado pode ter no máximo 90 dias." }, 400);
    if (requestedTo > new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" })) return json({ error: "A data final não pode ser futura." }, 400);
  } else if (![7, 30, 90].includes(days)) {
    return json({ error: "Escolha um período de 7, 30, 90 dias ou informe datas personalizadas." }, 400);
  }

  let session = await readSession(request, env);
  if (!session) return json({ error: "Conecte sua conta do Mercado Livre para consultar o desempenho.", login_url: "/auth/login" }, 401);

  let refreshed = false;
  let refreshPromise = null;
  let apiRequestsUsed = 0;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) return json({ error: "A autorização expirou. Conecte sua conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() });
    refreshed = true;
  }

  const requestApi = async (target) => {
    const apiUrl = target.startsWith("http") ? target : API_BASE + target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (apiRequestsUsed >= API_REQUEST_BUDGET) throw new Error("Limite interno de chamadas desta consulta atingido.");
        apiRequestsUsed += 1;
        const tokenUsed = session.access_token;
        let response = await fetch(apiUrl, { headers: { Accept: "application/json", Authorization: "Bearer " + tokenUsed } });
        if (response.status === 401) {
          if (!refreshPromise && !refreshed) refreshPromise = refreshSession(session, env);
          const nextSession = refreshPromise ? await refreshPromise : null;
          if (nextSession) {
            session = nextSession;
            refreshed = true;
            refreshPromise = null;
          }
          if (session.access_token !== tokenUsed) {
            if (apiRequestsUsed >= API_REQUEST_BUDGET) throw new Error("Limite interno de chamadas desta consulta atingido.");
            apiRequestsUsed += 1;
            response = await fetch(apiUrl, { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
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
  const visitIds = visitsOnly
    ? itemIds.slice(requestedVisitOffset, requestedVisitOffset + VISIT_BATCH_SIZE)
    : itemIds.slice(0, MAX_VISIT_LOOKUPS);
  const ending = new Date().toISOString().slice(0, 10);
  let dateTo = ending + "T00:00:00.000Z";
  let dateFrom = new Date(Date.parse(dateTo) - days * 86_400_000).toISOString();

  if (customPeriod) { dateFrom = brazilDayStart(requestedFrom).toISOString(); dateTo = brazilDayEnd(requestedTo).toISOString(); }

  const visits = {};
  const visitDateRanges = [];
  const visitFailures = [];
  const loadVisit = async (itemId) => {
    const visitUrl = customPeriod ? new URL(API_BASE + "/items/visits") : new URL(API_BASE + "/items/" + encodeURIComponent(itemId) + "/visits/time_window");
    if (customPeriod) {
      visitUrl.searchParams.set("ids", itemId);
      visitUrl.searchParams.set("date_from", requestedFrom);
      visitUrl.searchParams.set("date_to", requestedTo);
    } else {
      visitUrl.searchParams.set("last", String(days));
      visitUrl.searchParams.set("unit", "day");
      visitUrl.searchParams.set("ending", ending);
    }
    try {
      const response = await requestApi(visitUrl.pathname + visitUrl.search);
      if (!response.ok) {
        visitFailures.push(response.status);
        visits[itemId] = null;
        return;
      }
      const payload = await response.json();
      const record = Array.isArray(payload) ? payload.find((entry) => entry?.item_id === itemId) || payload[0] : (payload && typeof payload[itemId] === "object" ? payload[itemId] : payload);
      visits[itemId] = finiteAmount(record?.total_visits ?? record?.visits ?? (typeof record === "number" ? record : null));
      if (record?.date_from && record?.date_to) visitDateRanges.push({ from: record.date_from, to: record.date_to });
    } catch {
      visits[itemId] = null;
      visitFailures.push(0);
    }
  };
  for (let i = 0; i < visitIds.length; i += 5) {
    await Promise.all(visitIds.slice(i, i + 5).map(loadVisit));
  }

  if (visitDateRanges.length && !customPeriod) {
    dateFrom = visitDateRanges[0].from;
    dateTo = visitDateRanges[0].to;
  }

  const salesByItem = {};
  const ordersScanned = 0;
  const ordersTotal = null;
  const ordersPartial = true;
  const salesError = null;

  if (visitsOnly) {
    const missing = visitIds.filter((id) => visits[id] === null).length;
    const errorSummary = Object.entries(visitFailures.reduce((counts, status) => { const label = status ? "HTTP " + status : "conexão"; counts[label] = (counts[label] || 0) + 1; return counts; }, {})).map(([label, count]) => label + ": " + count).join(", ");
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ items: visitIds.map((id) => ({ id, visits: visits[id] ?? null })), visits_partial: missing > 0, visits_unavailable_count: missing, visits_error: visitFailures.length ? "A consulta falhou para " + visitFailures.length + " anúncio(s) (" + errorSummary + ")." : null }, 200, headers);
  }

  const visitFailureSummary = Object.entries(visitFailures.reduce((counts, status) => { const label = status ? "HTTP " + status : "conexão"; counts[label] = (counts[label] || 0) + 1; return counts; }, {})).map(([label, count]) => label + ": " + count).join(", ");
  const items = itemIds.map((id) => {
    const sales = salesByItem[id] || { units: 0, gross: 0 };
    return { id, visits: visits[id] ?? null, units_sold: salesError ? null : sales.units, gross_sales: salesError ? null : Math.round(sales.gross * 100) / 100 };
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
      units_sold: salesError ? null : items.reduce((sum, item) => sum + (item.units_sold || 0), 0),
      gross_sales: salesError ? null : Math.round(items.reduce((sum, item) => sum + (item.gross_sales || 0), 0) * 100) / 100
    },
    orders: { scanned: ordersScanned, total: ordersTotal, partial: ordersPartial, next_offset: 0 },
    visits_partial: itemIds.length > visitIds.length || visitFailures.length > 0,
    visits_unavailable_count: itemIds.length - Object.values(visits).filter((value) => value !== null).length,
    sales_error: salesError,
    visits_error: visitFailures.length ? "A consulta falhou para " + visitFailures.length + " anúncio(s) (" + visitFailureSummary + ")." : null
  }, 200, headers);
}

async function waitBeforeRetry(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(2000, retryAfter * 1000) : (attempt === 0 ? 300 : 800);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
function parseDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

function brazilDayStart(value) { return new Date(Date.parse(value + "T03:00:00.000Z")); }
function brazilDayEnd(value) { return new Date(Date.parse(value + "T03:00:00.000Z") + 86_400_000 - 1); }
function formatOrdersDate(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Data inválida para consulta de pedidos.");
  return parsed.toISOString().replace(/Z$/, "-00:00");
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
