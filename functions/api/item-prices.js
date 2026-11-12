import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const MAX_ITEMS = 10;
const CONCURRENCY = 5;

export async function onRequestPost({ request, env }) {
  try {
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Envie os IDs em formato JSON." }, 415);
    const body = await request.json().catch(() => null);
    const ids = validIds(body?.item_ids, MAX_ITEMS);
    if (!ids.length) return json({ error: "Envie até 10 IDs de anúncios válidos." }, 400);
    const auth = await getSession(request, env);
    if (auth.response) return auth.response;
    const { session, refreshed } = auth;
    const results = [];
    const unavailable = {};
    const recordFailure = (reason) => { unavailable[reason] = (unavailable[reason] || 0) + 1; };
    for (let start = 0; start < ids.length; start += CONCURRENCY) {
      const batch = await Promise.all(ids.slice(start, start + CONCURRENCY).map(async (id) => {
        try {
          const response = await fetch(API_BASE + "/items/" + encodeURIComponent(id) + "/sale_price?context=channel_marketplace", {
            headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token }
          });
          if (!response.ok) {
            recordFailure("HTTP " + response.status);
            return { id, price: null, regular_price: null, is_promotional: false, price_source: "unavailable" };
          }
          const sale = await response.json();
          const price = amount(sale.amount);
          if (price === null) {
            recordFailure("resposta sem preço");
            return { id, price: null, regular_price: null, is_promotional: false, price_source: "unavailable" };
          }
          const regular = amount(sale.regular_amount);
          return { id, price, regular_price: regular, is_promotional: regular !== null && regular > price, price_source: "sale_price", currency_id: sale.currency_id || "BRL" };
        } catch {
          recordFailure("conexão");
          return { id, price: null, regular_price: null, is_promotional: false, price_source: "unavailable" };
        }
      }));
      results.push(...batch);
    }
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ results, pricing_unavailable_count: Object.values(unavailable).reduce((sum, count) => sum + count, 0), pricing_unavailable_statuses: unavailable }, 200, headers);
  } catch {
    return json({ error: "Falha interna ao consultar os preços dos anúncios." }, 500);
  }
}

async function getSession(request, env) {
  let session = await readSession(request, env);
  if (!session) return { response: json({ error: "Conecte sua conta do Mercado Livre para consultar os preços.", login_url: "/auth/login" }, 401) };
  let refreshed = false;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) return { response: json({ error: "A autorização expirou. Conecte sua conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() }) };
    refreshed = true;
  }
  return { session, refreshed };
}
async function refreshSession(session, env) {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) return null;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: env.ML_CLIENT_ID, client_secret: env.ML_CLIENT_SECRET, refresh_token: session.refresh_token });
    const response = await fetch(API_BASE + "/oauth/token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body });
    const tokens = await response.json();
    return response.ok && tokens.access_token && tokens.refresh_token ? { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + Number(tokens.expires_in || 21600) * 1000 } : null;
  } catch { return null; }
}
function validIds(value, max) { return [...new Set((Array.isArray(value) ? value : []).filter((id) => typeof id === "string" && /^MLB[0-9]{6,20}$/.test(id)))].slice(0, max); }
function amount(value) { const parsed = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(parsed) ? parsed : null; }
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } }); }
