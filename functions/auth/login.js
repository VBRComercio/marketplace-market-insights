import { redirectResponse } from "../_lib/session.js";

export async function onRequestGet({ request, env }) {
  if (!env.ML_CLIENT_ID) {
    return new Response("Configure ML_CLIENT_ID nas variáveis do Cloudflare Pages antes de iniciar o OAuth.", {
      status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  const stateBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const state = base64url(stateBytes);
  const verifier = base64url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(digest);

  const authorization = new URL("https://auth.mercadolivre.com.br/authorization");
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", env.ML_CLIENT_ID);
  authorization.searchParams.set("redirect_uri", "https://marketplace-market-insights.pages.dev/oauth/callback");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", challenge);
  authorization.searchParams.set("code_challenge_method", "S256");

  const cookieOptions = "Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax";
  return redirectResponse(authorization.toString(), [
    `__Host-ml_state=${state}; ${cookieOptions}`,
    `__Host-ml_verifier=${verifier}; ${cookieOptions}`
  ]);
}

function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
