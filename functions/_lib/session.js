const SESSION_COOKIE = "__Host-ml_session";
const REDIRECT_URI = "https://marketplace-market-insights.pages.dev/oauth/callback";
const textEncoder = new TextEncoder();

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function base64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), (char) => char.charCodeAt(0));
}

async function encryptionKey(env) {
  if (!env.ML_CLIENT_SECRET) throw new Error("ML_CLIENT_SECRET não configurado.");
  const material = await crypto.subtle.digest("SHA-256", textEncoder.encode("market-insights-session:" + env.ML_CLIENT_SECRET));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function readCookie(request, name) {
  return parseCookies(request)[name] || null;
}

export async function readSession(request, env) {
  const value = readCookie(request, SESSION_COOKIE);
  if (!value) return null;
  try {
    const packed = fromBase64url(value);
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await encryptionKey(env), ciphertext);
    const session = JSON.parse(new TextDecoder().decode(plaintext));
    if (!session.access_token || !session.refresh_token || !session.expires_at) return null;
    return session;
  } catch {
    return null;
  }
}

export async function sessionCookie(session, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(session));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), plaintext);
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return `${SESSION_COOKIE}=${base64url(packed)}; Path=/; Max-Age=15552000; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function clearOAuthCookies() {
  return [
    "__Host-ml_state=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    "__Host-ml_verifier=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
  ];
}

export function redirectResponse(location, cookies = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

export function htmlResponse(title, message, status = 200) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safeTitle}</title><body style="font:16px system-ui;max-width:620px;margin:12vh auto;padding:24px;color:#182230"><h1>${safeTitle}</h1><p>${safeMessage}</p><p><a href="/">Voltar ao Radar de Mercado</a></p></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

export { REDIRECT_URI };
