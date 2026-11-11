import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const DEFAULT_RATES = { nf_percent: 4, ads_percent: 2.5, defect_percent: 2, operational_percent: 5, stock_alert_days: 7 };

export async function onRequest({ request, env }) {
  try {
    if (!env.DB) return json({ error: "O armazenamento do cadastro ainda não está vinculado ao projeto." }, 503);
    const sessionResult = await getSellerSession(request, env);
    if (sessionResult.response) return sessionResult.response;
    const { session, sellerId, nickname, refreshed } = sessionResult;
    if (request.method === "GET") return await getConfig(request, env.DB, sellerId, nickname, session, env, refreshed);
    if (request.method === "POST") {
      const origin = request.headers.get("Origin");
      if (origin && origin !== new URL(request.url).origin) return json({ error: "Origem da solicitação inválida." }, 403);
      return await saveConfig(request, env.DB, sellerId, session, env, refreshed);
    }
    return json({ error: "Método não permitido." }, 405, { Allow: "GET, POST" });
  } catch (error) {
    const message = error?.message || "";
    if (/no such table|does not exist|no database/i.test(message)) {
      return json({ error: "O banco ainda não tem a migração do cadastro aplicada." }, 503);
    }
    return json({ error: "Falha ao acessar o cadastro de custos e parâmetros." }, 500);
  }
}

async function getConfig(request, db, sellerId, nickname, session, env, refreshed) {
  const today = brazilDateString();
  const ratesResult = await db.prepare(
    "SELECT effective_from, nf_percent, ads_percent, defect_percent, operational_percent, stock_alert_days FROM account_rate_history WHERE seller_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1"
  ).bind(String(sellerId), today).first();
  const url = new URL(request.url);
  const itemIds = [...new Set((url.searchParams.get("item_ids") || "").split(",").map((id) => id.trim()).filter((id) => /^[A-Z]{3}[0-9]+$/.test(id)))].slice(0, 50);
  let mappings = [];
  if (itemIds.length) {
    const placeholders = itemIds.map(() => "?").join(",");
    const result = await db.prepare(
      "SELECT item_id, sku FROM listing_sku_map WHERE seller_id = ? AND item_id IN (" + placeholders + ")"
    ).bind(String(sellerId), ...itemIds).all();
    mappings = result.results || [];
  }
  const costs = await db.prepare(
    "SELECT sku, lot_code, effective_from, unit_cost, packaging_cost FROM (SELECT sku, lot_code, effective_from, unit_cost, packaging_cost, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY effective_from DESC, id DESC) AS row_number FROM sku_cost_history WHERE seller_id = ? AND effective_from <= ?) WHERE row_number = 1"
  ).bind(String(sellerId), today).all();
  const ratesHistory = await db.prepare(
    "SELECT effective_from, nf_percent, ads_percent, defect_percent, operational_percent, stock_alert_days FROM account_rate_history WHERE seller_id = ? ORDER BY effective_from DESC, id DESC LIMIT 100"
  ).bind(String(sellerId)).all();
  const costsHistory = await db.prepare(
    "SELECT sku, lot_code, effective_from, unit_cost, packaging_cost FROM sku_cost_history WHERE seller_id = ? ORDER BY effective_from DESC, id DESC LIMIT 250"
  ).bind(String(sellerId)).all();
  const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
  return json({
    seller: { id: sellerId, nickname: nickname || null },
    rates: ratesResult || { ...DEFAULT_RATES, effective_from: null },
    rates_configured: Boolean(ratesResult),
    mappings,
    latest_costs: costs.results || [],
    rates_history: ratesHistory.results || [],
    costs_history: costsHistory.results || []
  }, 200, headers);
}

async function saveConfig(request, db, sellerId, session, env, refreshed) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return json({ error: "Envie o cadastro em formato JSON." }, 415);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Cadastro inválido." }, 400);
  const effectiveFrom = validDate(body.effective_from);
  if (!effectiveFrom) return json({ error: "Informe uma data de vigência válida." }, 400);

  if (body.type === "rates") {
    const rates = {
      nf_percent: validPercent(body.nf_percent),
      ads_percent: validPercent(body.ads_percent),
      defect_percent: validPercent(body.defect_percent),
      operational_percent: validPercent(body.operational_percent),
      stock_alert_days: validRange(body.stock_alert_days, 0, 365)
    };
    if (Object.values(rates).some((value) => value === null)) return json({ error: "Informe percentuais entre 0 e 100." }, 400);
    await db.prepare(
      "INSERT INTO account_rate_history (seller_id, effective_from, nf_percent, ads_percent, defect_percent, operational_percent, stock_alert_days) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(seller_id, effective_from) DO UPDATE SET nf_percent = excluded.nf_percent, ads_percent = excluded.ads_percent, defect_percent = excluded.defect_percent, operational_percent = excluded.operational_percent, stock_alert_days = excluded.stock_alert_days"
    ).bind(String(sellerId), effectiveFrom, rates.nf_percent, rates.ads_percent, rates.defect_percent, rates.operational_percent, rates.stock_alert_days).run();
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ saved: true, type: "rates", effective_from: effectiveFrom, rates }, 200, headers);
  }

  if (body.type === "sku_cost") {
    const itemId = typeof body.item_id === "string" && /^[A-Z]{3}[0-9]+$/.test(body.item_id) ? body.item_id : null;
    const sku = typeof body.sku === "string" ? body.sku.trim().slice(0, 100) : "";
    const lotCode = typeof body.lot_code === "string" ? body.lot_code.trim().slice(0, 100) : "";
    const unitCost = validMoney(body.unit_cost);
    const packagingCost = validMoney(body.packaging_cost);
    if (!itemId || !sku || !lotCode || unitCost === null || packagingCost === null) {
      return json({ error: "Preencha anúncio, SKU, lote, custo do produto e embalagem com valores válidos." }, 400);
    }
    await db.batch([
      db.prepare(
        "INSERT INTO listing_sku_map (seller_id, item_id, sku) VALUES (?, ?, ?) ON CONFLICT(seller_id, item_id) DO UPDATE SET sku = excluded.sku, updated_at = CURRENT_TIMESTAMP"
      ).bind(String(sellerId), itemId, sku),
      db.prepare(
        "INSERT INTO sku_cost_history (seller_id, sku, lot_code, effective_from, unit_cost, packaging_cost) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(seller_id, sku, lot_code, effective_from) DO UPDATE SET unit_cost = excluded.unit_cost, packaging_cost = excluded.packaging_cost"
      ).bind(String(sellerId), sku, lotCode, effectiveFrom, unitCost, packagingCost)
    ]);
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ saved: true, type: "sku_cost", item_id: itemId, sku, lot_code: lotCode, effective_from: effectiveFrom }, 200, headers);
  }

  return json({ error: "Tipo de cadastro desconhecido." }, 400);
}

async function getSellerSession(request, env) {
  let session = await readSession(request, env);
  if (!session) return { response: json({ error: "Conecte sua conta do Mercado Livre para abrir o cadastro.", login_url: "/auth/login" }, 401) };
  let refreshed = false;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) return { response: json({ error: "A autorização expirou. Conecte a conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() }) };
    refreshed = true;
  }
  let response = await fetch(API_BASE + "/users/me", { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
  if (response.status === 401 && !refreshed) {
    const nextSession = await refreshSession(session, env);
    if (nextSession) {
      session = nextSession;
      refreshed = true;
      response = await fetch(API_BASE + "/users/me", { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return { response: json({ error: "Não foi possível identificar a conta do Mercado Livre.", request_id: response.headers.get("x-request-id"), detail: safeMessage(payload) }, response.status, headers) };
  }
  const me = await response.json();
  if (!me.id) return { response: json({ error: "O Mercado Livre não retornou o ID da conta." }, 502) };
  return { session, sellerId: me.id, nickname: me.nickname, refreshed };
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
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + Number(tokens.expires_in || 21600) * 1000 };
  } catch { return null; }
}

function brazilDateString() { const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const values = Object.fromEntries(parts.map((part) => [part.type, part.value])); return values.year + "-" + values.month + "-" + values.day; }
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + "T12:00:00-03:00");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function validRange(value, minimum, maximum) { const number = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= minimum && number <= maximum ? number : null; }
function validPercent(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}
function validMoney(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0 && number <= 10_000_000 ? Math.round(number * 100) / 100 : null;
}
function validQuantity(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 10_000_000 ? number : false;
}
function safeMessage(payload) {
  return payload && typeof payload === "object" ? [payload.message, payload.error].find((value) => typeof value === "string")?.slice(0, 200) || "" : "";
}
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders }
  });
}
