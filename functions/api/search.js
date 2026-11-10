import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const MAX_RESULTS = 50;

export async function onRequestGet({ request, env }) {
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

  const upstream = new URL(`${API_BASE}/sites/MLB/search`);
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("limit", String(MAX_RESULTS));
  upstream.searchParams.set("sort", "relevance");

  try {
    const response = await fetch(upstream, {
      headers: { Accept: "application/json", Authorization: `Bearer ${session.access_token}`, "User-Agent": "MarketplaceMarketInsights/1.0" }
    });
    if (response.status === 401) {
      return json({ error: "A autorização foi revogada ou expirou. Conecte a conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() });
    }
    if (!response.ok) {
      const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
      if (response.status === 429) return json({ error: "O Mercado Livre limitou temporariamente as consultas. Aguarde um pouco e tente novamente." }, 429, headers);
      const apiError = await response.json().catch(() => null);
      const detail = describeApiError(apiError);
      const suffix = detail ? ` Detalhe informado pela API: ${detail}` : "";
      return json({ error: `A API do Mercado Livre respondeu com erro (${response.status}).${suffix}` }, 502, headers);
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
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({
      query,
      site: "MLB",
      paging: { total: raw.paging?.total ?? results.length, limit: MAX_RESULTS },
      results
    }, 200, headers);
  } catch {
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return json({ error: "Não foi possível conectar à API do Mercado Livre. Tente novamente." }, 502, headers);
  }
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
    const response = await fetch(`${API_BASE}/oauth/token`, {
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
