import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const MAX_ITEMS = 20;
const CONCURRENCY = 5;

export async function onRequestPost({ request, env }) {
  try {
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Envie os dados em formato JSON." }, 415);
    const body = await request.json().catch(() => null);
    const ids = validIds(body?.item_ids, MAX_ITEMS);
    if (!ids.length) return json({ error: "Envie até 20 IDs de anúncios válidos." }, 400);
    const period = getPeriod(body);
    if (period.error) return json({ error: period.error }, 400);
    const auth = await getSession(request, env);
    if (auth.response) return auth.response;
    const { session, refreshed } = auth;
    const results = [];
    const failures = {};
    const recordFailure = (reason) => { failures[reason] = (failures[reason] || 0) + 1; };
    for (let start = 0; start < ids.length; start += CONCURRENCY) {
      const batch = await Promise.all(ids.slice(start, start + CONCURRENCY).map(async (id) => {
        const apiUrl = period.custom
          ? new URL(API_BASE + "/items/visits")
          : new URL(API_BASE + "/items/" + encodeURIComponent(id) + "/visits/time_window");
        if (period.custom) {
          apiUrl.searchParams.set("ids", id);
          apiUrl.searchParams.set("date_from", period.dateFrom);
          apiUrl.searchParams.set("date_to", period.dateTo);
        } else {
          apiUrl.searchParams.set("last", String(period.days));
          apiUrl.searchParams.set("unit", "day");
          apiUrl.searchParams.set("ending", period.ending);
        }
        try {
          const response = await fetch(apiUrl, { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
          if (!response.ok) {
            recordFailure("HTTP " + response.status);
            return { id, visits: null };
          }
          const payload = await response.json();
          const record = Array.isArray(payload) ? payload.find((entry) => entry?.item_id === id) || payload[0] : (payload && typeof payload[id] === "object" ? payload[id] : payload);
          return { id, visits: amount(record?.total_visits ?? record?.visits ?? (typeof record === "number" ? record : null)) };
        } catch {
          recordFailure("conexão");
          return { id, visits: null };
        }
      }));
      results.push(...batch);
    }
    const unavailable = results.filter((entry) => entry.visits === null).length;
    const detail = Object.entries(failures).map(([reason, count]) => reason + ": " + count).join(", ");
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ results, visits_partial: unavailable > 0, visits_unavailable_count: unavailable, visits_error: detail ? "A consulta falhou para " + Object.values(failures).reduce((sum, value) => sum + value, 0) + " anúncio(s) (" + detail + ")." : null }, 200, headers);
  } catch {
    return json({ error: "Falha interna ao consultar visitas dos anúncios." }, 500);
  }
}

async function getSession(request, env) {
  let session = await readSession(request, env);
  if (!session) return { response: json({ error: "Conecte sua conta do Mercado Livre para consultar as visitas.", login_url: "/auth/login" }, 401) };
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
function getPeriod(body) {
  const from = body?.date_from;
  const to = body?.date_to;
  const custom = Boolean(from || to);
  if (custom) {
    const fromTime = parseDate(from), toTime = parseDate(to);
    if (fromTime === null || toTime === null || toTime < fromTime) return { error: "Informe um intervalo de datas válido." };
    if (Math.floor((toTime - fromTime) / 86400000) + 1 > 90) return { error: "O período personalizado pode ter no máximo 90 dias." };
    if (to > brazilToday()) return { error: "A data final não pode ser futura." };
    return { custom: true, dateFrom: from, dateTo: to };
  }
  const days = Number.parseInt(body?.days || "7", 10);
  if (![7, 30, 90].includes(days)) return { error: "Escolha um período de 7, 30 ou 90 dias." };
  return { custom: false, days, ending: new Date().toISOString().slice(0, 10) };
}
function parseDate(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null; const parsed = Date.parse(value + "T00:00:00.000Z"); return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : null; }
function brazilToday() { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); return parts; }
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } }); }
