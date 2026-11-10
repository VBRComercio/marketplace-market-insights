import { readCookie, sessionCookie, clearOAuthCookies, redirectResponse, htmlResponse, REDIRECT_URI } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const savedState = readCookie(request, "__Host-ml_state");
  const verifier = readCookie(request, "__Host-ml_verifier");
  const clearCookies = clearOAuthCookies();

  if (url.searchParams.has("error")) {
    return htmlResponse("Autorização não concluída", "O Mercado Livre não autorizou o acesso. Volte ao site e tente novamente.", 400WithNo);
  }
  if (!code || !returnedState || !savedState || returnedState !== savedState || !verifier) {
    return new Response("Retorno OAuth inválido ou expirado. Inicie novamente pelo botão Conectar Mercado Livre.", {
      status: 400, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) {
    return new Response("Configure ML_CLIENT_ID e ML_CLIENT_SECRET em Cloudflare Pages > Settings > Variables and Secrets.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    });
    const tokenResponse = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) {
      return htmlResponse("Não foi possível conectar", "O Mercado Livre recusou a troca do código por tokens. Confira o Client ID, o Client Secret e se a URI de redirecionamento cadastrada corresponde exatamente à do site.", 502);
    }

    const cookie = await sessionCookie({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + Number(tokens.expires_in || 21600) * 1000
    }, env);
    const response = redirectResponse("/?oauth=connected", [...clearCookies, cookie]);
    return response;
  } catch {
    return htmlResponse("Erro ao conectar", "Não foi possível concluir a autorização agora. Tente novamente.", 502);
  }
}
