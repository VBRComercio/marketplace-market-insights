import { readCookie, sessionCookie, clearOAuthCookies, redirectResponse, htmlResponse, REDIRECT_URI } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const savedState = readCookie(request, "__Host-ml_state");
  const verifier = readCookie(request, "__Host-ml_verifier");
  const clearCookies = clearOAuthCookies();

  if (url.searchParams.has("error")) {
    const response = htmlResponse("Autorização não concluída", "O Mercado Livre não autorizou o acesso. Volte ao site e tente novamente.", 400);
    for (const cookie of clearCookies) response.headers.append("Set-Cookie", cookie);
    return response;
  }
  if (!code || !returnedState || !savedState || returnedState !== savedState || !verifier) {
    const response = htmlResponse("Retorno OAuth inválido", "O retorno expirou ou não corresponde ao início do login. Volte ao site e clique novamente em Conectar Mercado Livre.", 400);
    for (const cookie of clearCookies) response.headers.append("Set-Cookie", cookie);
    return response;
  }
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) {
    const response = htmlResponse("Credenciais não configuradas", "No Cloudflare Pages, configure ML_CLIENT_ID e ML_CLIENT_SECRET em Settings > Variables and Secrets.", 503);
    for (const cookie of clearCookies) response.headers.append("Set-Cookie", cookie);
    return response;
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
      const response = htmlResponse("Não foi possível conectar", "O Mercado Livre recusou a troca do código por tokens. Confira o Client ID, o Client Secret e se a URI de redirecionamento cadastrada corresponde exatamente à do site.", 502);
      for (const cookie of clearCookies) response.headers.append("Set-Cookie", cookie);
      return response;
    }

    const cookie = await sessionCookie({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + Number(tokens.expires_in || 21600) * 1000
    }, env);
    return redirectResponse("/?oauth=connected", [...clearCookies, cookie]);
  } catch {
    const response = htmlResponse("Erro ao conectar", "Não foi possível concluir a autorização agora. Tente novamente.", 502);
    for (const cookie of clearCookies) response.headers.append("Set-Cookie", cookie);
    return response;
  }
}
