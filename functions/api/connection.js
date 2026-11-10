import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";

export async function onRequestGet({ request, env }) {
  let session = await readSession(request, env);
  if (!session) return json({ connected: false, state: "disconnected" });

  let refreshed = false;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) {
      return json({ connected: false, state: "expired" }, 401, { "Set-Cookie": clearSessionCookie() });
    }
    refreshed = true;
  }

  let response;
  try {
    response = await fetch(API_BASE + "/users/me", {
      headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token }
    });

    if (response.status === 401 && !refreshed) {
      session = await refreshSession(session, env);
      if (!session) {
        return json({ connected: false, state: "expired" }, 401, { "Set-Cookie": clearSessionCookie() });
      }
      refreshed = true;
      response = await fetch(API_BASE + "/users/me", {
        headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token }
      });
    }
  } catch {
    return json({ connected: false, state: "check_failed", message: "Não foi possível validar a conexão com o Mercado Livre agora." }, 502);
  }

  const cookieHeaders = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
  if (response.status === 401) {
    return json({ connected: false, state: "expired" }, 401, { "Set-Cookie": clearSessionCookie() });
  }
  if (!response.ok) {
    return json({
      connected: false,
      state: "check_failed",
      message: "A sessão existe, mas o Mercado Livre não confirmou a conta.",
      upstream_status: response.status,
      request_id: response.headers.get("x-request-id")
    }, 502, cookieHeaders);
  }

  const user = await response.json();
  return json({
    connected: true,
    state: "active",
    user_id: user.id ?? null,
    nickname: user.nickname ?? null,
    site_id: user.site_id ?? null,
    expires_at: session.expires_at,
    checked_at: new Date().toISOString()
  }, 200, cookieHeaders);
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
