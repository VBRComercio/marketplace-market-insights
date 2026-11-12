import { readSession, sessionCookie, clearSessionCookie } from "../_lib/session.js";

const API_BASE = "https://api.mercadolibre.com";
const MAX_ITEMS = 20;
const FALLBACK_RATES = { nf_percent: 4, ads_percent: 2.5, defect_percent: 2, operational_percent: 5 };

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) return json({ error: "O armazenamento do cadastro ainda não está vinculado ao projeto." }, 503);
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Envie os anúncios em formato JSON." }, 415);
    const body = await request.json().catch(() => null);
    const items = Array.isArray(body?.items) ? body.items.slice(0, MAX_ITEMS) : [];
    if (!items.length) return json({ error: "Envie até 20 anúncios para calcular a margem." }, 400);

    const auth = await getSeller(request, env);
    if (auth.response) return auth.response;
    const { session, seller, refreshed } = auth;
    const sellerId = String(seller.id);
    const today = brazilDateString();
    const rates = await env.DB.prepare(
      "SELECT nf_percent, ads_percent, defect_percent, operational_percent FROM account_rate_history WHERE seller_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1"
    ).bind(sellerId, today).first() || FALLBACK_RATES;

    const itemIds = items.map((item) => item.id).filter((id) => typeof id === "string" && /^[A-Z]{3}[0-9]+$/.test(id));
    const mappingRows = itemIds.length
      ? await env.DB.prepare("SELECT item_id, sku FROM listing_sku_map WHERE seller_id = ? AND item_id IN (" + itemIds.map(() => "?").join(",") + ")").bind(sellerId, ...itemIds).all()
      : { results: [] };
    const skuMap = new Map((mappingRows.results || []).map((row) => [row.item_id, row.sku]));
    const costRows = await env.DB.prepare(
      "SELECT sku, lot_code, effective_from, unit_cost, packaging_cost FROM (SELECT sku, lot_code, effective_from, unit_cost, packaging_cost, ROW_NUMBER() OVER (PARTITION BY sku ORDER BY effective_from DESC, id DESC) AS row_number FROM sku_cost_history WHERE seller_id = ? AND effective_from <= ?) WHERE row_number = 1"
    ).bind(sellerId, today).all();
    const costMap = new Map((costRows.results || []).map((row) => [row.sku, row]));

    let currentSession = session;
    let refreshedSession = refreshed;
    let refreshPromise = null;
    const requestApi = async (url) => {
      const tokenUsed = currentSession.access_token;
      let response = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + tokenUsed } });
      if (response.status !== 401) return response;
      if (currentSession.access_token !== tokenUsed) {
        return fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + currentSession.access_token } });
      }
      if (!refreshedSession) {
        if (!refreshPromise) refreshPromise = refreshSession(currentSession, env);
        const next = await refreshPromise;
        if (next) {
          currentSession = next;
          refreshedSession = true;
          refreshPromise = null;
        }
      }
      if (currentSession.access_token !== tokenUsed) {
        response = await fetch(url, { headers: { Accept: "application/json", Authorization: "Bearer " + currentSession.access_token } });
      }
      return response;
    };

    const results = await Promise.all(items.map(async (item) => {
      if (!item || typeof item.id !== "string" || !/^[A-Z]{3}[0-9]+$/.test(item.id)) return null;
      let price = amount(item.price);
      let itemDetails = null;
      let listingType = safeText(item.listing_type_id);
      let category = safeText(item.category_id);
      if (price === null || !listingType || !category) {
        try {
          const detailResponse = await requestApi(API_BASE + "/items/" + encodeURIComponent(item.id));
          if (detailResponse.ok) itemDetails = await detailResponse.json();
        } catch {}
        listingType = listingType || safeText(itemDetails?.listing_type_id);
        category = category || safeText(itemDetails?.category_id);
      }
      if (price === null) {
        try {
          const salePriceUrl = new URL(API_BASE + "/items/" + encodeURIComponent(item.id) + "/sale_price");
          salePriceUrl.searchParams.set("context", "channel_marketplace");
          const saleResponse = await requestApi(salePriceUrl.toString());
          if (saleResponse.ok) price = amount((await saleResponse.json()).amount);
        } catch {}
      }
      const currencyId = safeText(item.currency_id) || safeText(itemDetails?.currency_id) || "BRL";
      const mode = safeText(item.shipping?.mode) || safeText(itemDetails?.shipping?.mode);
      const logisticType = safeText(item.shipping?.logistic_type) || safeText(itemDetails?.shipping?.logistic_type);
      const sellerSku = skuMap.get(item.id) || safeText(item.seller_sku) || safeText(itemDetails?.seller_custom_field) || safeText(itemDetails?.attributes?.find((attribute) => attribute.id === "SELLER_SKU")?.value_name);
      const cost = sellerSku ? costMap.get(sellerSku) : null;
      if (price === null || !listingType || !category) {
        const unavailable = [];
        if (price === null) unavailable.push("preço de venda");
        if (!category) unavailable.push("categoria");
        if (!listingType) unavailable.push("modalidade");
        return { id: item.id, sku: sellerSku || null, contribution_margin: null, estimated_margin: null, missing: ["Dados não retornados pela API: " + unavailable.join(", ") + "."] };
      }

      const feesUrl = new URL(API_BASE + "/sites/MLB/listing_prices");
      feesUrl.searchParams.set("price", String(price));
      feesUrl.searchParams.set("category_id", category);
      feesUrl.searchParams.set("currency_id", currencyId);
      feesUrl.searchParams.set("listing_type_id", listingType);
      feesUrl.searchParams.set("channel", "marketplace");
      if (mode) feesUrl.searchParams.set("shipping_mode", mode);
      if (logisticType) feesUrl.searchParams.set("logistic_type", logisticType);

      const shippingUrl = new URL(API_BASE + "/users/" + encodeURIComponent(String(seller.id)) + "/shipping_options/free");
      shippingUrl.searchParams.set("item_id", item.id);
      shippingUrl.searchParams.set("item_price", String(price));
      shippingUrl.searchParams.set("listing_type_id", listingType);
      if (mode) shippingUrl.searchParams.set("mode", mode);
      if (safeText(item.condition)) shippingUrl.searchParams.set("condition", item.condition);
      if (logisticType) shippingUrl.searchParams.set("logistic_type", logisticType);
      shippingUrl.searchParams.set("free_shipping", String(Boolean(item.shipping?.free_shipping)));
      const [feesResponse, shippingResponse] = await Promise.all([requestApi(feesUrl.toString()), requestApi(shippingUrl.toString())]);
      const missing = [];
      let saleFee = null;
      let sellerShipping = null;
      if (feesResponse.ok) {
        const payload = await feesResponse.json().catch(() => null);
        const feeEntries = Array.isArray(payload) ? payload.flat(4) : [payload];
        const fee = feeEntries.find((entry) => entry?.listing_type_id === listingType) || feeEntries[0];
        saleFee = amount(fee?.sale_fee_amount);
      } else missing.push("Tarifa de venda indisponível.");
      if (shippingResponse.ok) {
        const payload = await shippingResponse.json().catch(() => null);
        sellerShipping = amount(payload?.coverage?.all_country?.list_cost);
      } else missing.push("Frete do vendedor não retornado pela API.");
      if (saleFee === null) missing.push("Tarifa de venda inválida.");
      if (sellerShipping === null) missing.push("Custo de envio não disponível.");

      const contribution = saleFee !== null && sellerShipping !== null ? round(price - saleFee - sellerShipping) : null;
      const unitCost = amount(cost?.unit_cost);
      const packagingCost = amount(cost?.packaging_cost);
      const estimated = contribution !== null && unitCost !== null && packagingCost !== null
        ? round(contribution - unitCost - packagingCost - price * (Number(rates.nf_percent) + Number(rates.ads_percent) + Number(rates.defect_percent) + Number(rates.operational_percent)) / 100)
        : null;
      if (!sellerSku) missing.push("SKU não cadastrado para este anúncio.");
      else if (!cost) missing.push("Custo do SKU/lote não cadastrado para esta data.");
      return {
        id: item.id,
        sku: sellerSku || null,
        sale_price: price,
        sale_fee: saleFee,
        seller_shipping: sellerShipping,
        contribution_margin: contribution,
        unit_cost: unitCost,
        packaging_cost: packagingCost,
        estimated_margin: estimated,
        rates,
        missing
      };
    }));

    const headers = refreshedSession ? { "Set-Cookie": await sessionCookie(currentSession, env) } : {};
    return json({ seller: { id: seller.id, nickname: seller.nickname || null }, effective_from: today, results: results.filter(Boolean) }, 200, headers);
  } catch (error) {
    if (/no such table|does not exist/i.test(error?.message || "")) return json({ error: "A migração do cadastro ainda não foi aplicada ao banco." }, 503);
    return json({ error: "Falha ao calcular o repasse previsto e as margens." }, 500);
  }
}

async function getSeller(request, env) {
  let session = await readSession(request, env);
  if (!session) return { response: json({ error: "Conecte a conta do Mercado Livre para calcular a margem.", login_url: "/auth/login" }, 401) };
  let refreshed = false;
  if (session.expires_at <= Date.now() + 60_000) {
    session = await refreshSession(session, env);
    if (!session) return { response: json({ error: "A autorização expirou. Conecte a conta novamente.", login_url: "/auth/login" }, 401, { "Set-Cookie": clearSessionCookie() }) };
    refreshed = true;
  }
  let response = await fetch(API_BASE + "/users/me", { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
  if (response.status === 401 && !refreshed) {
    const next = await refreshSession(session, env);
    if (next) {
      session = next;
      refreshed = true;
      response = await fetch(API_BASE + "/users/me", { headers: { Accept: "application/json", Authorization: "Bearer " + session.access_token } });
    }
  }
  if (!response.ok) {
    const headers = refreshed ? { "Set-Cookie": await sessionCookie(session, env) } : {};
    return { response: json({ error: "Não foi possível identificar sua conta no Mercado Livre.", request_id: response.headers.get("x-request-id") }, response.status, headers) };
  }
  const seller = await response.json();
  return seller?.id ? { session, seller, refreshed } : { response: json({ error: "O Mercado Livre não retornou o ID da conta." }, 502) };
}

async function refreshSession(session, env) {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) return null;
  try {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: env.ML_CLIENT_ID, client_secret: env.ML_CLIENT_SECRET, refresh_token: session.refresh_token });
    const response = await fetch(API_BASE + "/oauth/token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body });
    const tokens = await response.json();
    return response.ok && tokens.access_token && tokens.refresh_token
      ? { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + Number(tokens.expires_in || 21600) * 1000 }
      : null;
  } catch { return null; }
}
function brazilDateString() { const parts = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()); const values = Object.fromEntries(parts.map((part) => [part.type, part.value])); return values.year + "-" + values.month + "-" + values.day; }
function safeText(value) { return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : ""; }
function amount(value) { const number = Number(value); return value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0 ? number : null; }
function round(value) { return Math.round(value * 100) / 100; }
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } }); }
