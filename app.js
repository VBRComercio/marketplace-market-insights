const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const button = document.querySelector("#search-button");
const statusEl = document.querySelector("#status");
const resultsEl = document.querySelector("#results");
const rowsEl = document.querySelector("#listing-rows");
const connectionBadge = document.querySelector("#connection-badge");
const authLink = document.querySelector("#auth-link");
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const showError = (message, loginUrl, diagnostics = {}) => {
  statusEl.replaceChildren(document.createTextNode(message));
  statusEl.className = "status error";
  if (diagnostics.request_id) {
    const detail = document.createElement("small");
    detail.className = "status-detail";
    detail.textContent = "ID da requisição: " + diagnostics.request_id + (diagnostics.api_date ? " · Horário da API: " + diagnostics.api_date : "");
    statusEl.append(document.createElement("br"), detail);
  }
  if (loginUrl) {
    const link = document.createElement("a");
    link.href = loginUrl;
    link.textContent = "Conectar ao Mercado Livre";
    link.className = "inline-auth-link";
    statusEl.append(" ", link);
  }
};
const setConnection = (state, message) => {
  const dot = connectionBadge.querySelector("i");
  const label = connectionBadge.querySelector("span");
  connectionBadge.className = "api-badge connection-" + state;
  dot.dataset.state = state;
  label.textContent = message;
};

async function checkConnection() {
  setConnection("checking", "Verificando conexão…");
  try {
    const response = await fetch("/api/connection", { headers: { Accept: "application/json" }, cache: "no-store" });
    const data = await response.json();
    if (data.connected) {
      const account = data.nickname || ("usuário #" + data.user_id);
      setConnection("connected", "Conectado: " + account);
      authLink.textContent = "Reconectar Mercado Livre";
      statusEl.textContent = "Conta autorizada e token validado agora com o Mercado Livre.";
      statusEl.className = "status success";
      return;
    }
    if (data.state === "expired") {
      setConnection("disconnected", "Autorização expirada");
      authLink.textContent = "Reconectar Mercado Livre";
      statusEl.textContent = "A autorização expirou. Reconecte a conta para continuar.";
      statusEl.className = "status error";
      return;
    }
    if (data.state === "check_failed" || !response.ok) {
      setConnection("unknown", "Não foi possível validar");
      statusEl.textContent = data.message || "Não foi possível confirmar a conexão com o Mercado Livre.";
      statusEl.className = "status error";
      return;
    }
    setConnection("disconnected", "Não conectado");
    authLink.textContent = "Conectar Mercado Livre";
    statusEl.textContent = "Conecte sua conta do Mercado Livre para autorizar pesquisas.";
    statusEl.className = "status";
  } catch {
    setConnection("unknown", "Status indisponível");
    statusEl.textContent = "Não foi possível consultar o status da conexão agora.";
    statusEl.className = "status error";
  }
}

const pageUrl = new URL(window.location.href);
const returnedFromOAuth = pageUrl.searchParams.get("oauth") === "connected";
if (returnedFromOAuth) {
  statusEl.textContent = "Autorização recebida; validando a conta…";
  pageUrl.searchParams.delete("oauth");
  window.history.replaceState({}, "", pageUrl.pathname + pageUrl.search + pageUrl.hash);
}
checkConnection();

async function search(query) {
  button.disabled = true;
  button.innerHTML = "Buscando <span>…</span>";
  statusEl.className = "status";
  statusEl.textContent = "Consultando anúncios no Mercado Livre…";
  resultsEl.hidden = true;
  try {
    const response = await fetch("/api/search?q=" + encodeURIComponent(query), { headers: { Accept: "application/json" }, cache: "no-store" });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      const body = await response.text();
      const title = body.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
      const detail = title ? " — " + title : "";
      showError("O servidor respondeu com uma página HTML em vez de JSON (HTTP " + response.status + detail + "). A função de busca pode estar com erro na implantação.");
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      showError(data.error || "Não foi possível consultar a API agora.", data.login_url, data);
      if (response.status === 401) checkConnection();
      return;
    }
    renderResults(query, data);
    statusEl.textContent = "";
  } catch (error) {
    showError(error.message || "Falha de conexão. Tente novamente.");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Pesquisar <span>→</span>';
  }
}

function renderResults(query, data) {
  const items = Array.isArray(data.results) ? data.results : [];
  const priced = items.filter((item) => Number.isFinite(Number(item.price)) && Number(item.price) > 0);
  const prices = priced.map((item) => Number(item.price));
  const average = prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null;
  const minItem = priced.reduce((best, item) => !best || Number(item.price) < Number(best.price) ? item : best, null);
  const maxItem = priced.reduce((best, item) => !best || Number(item.price) > Number(best.price) ? item : best, null);
  document.querySelector("#result-heading").textContent = "“" + query + "”";
  document.querySelector("#avg-price").textContent = average === null ? "—" : money.format(average);
  document.querySelector("#min-price").textContent = minItem ? money.format(Number(minItem.price)) : "—";
  document.querySelector("#max-price").textContent = maxItem ? money.format(Number(maxItem.price)) : "—";
  document.querySelector("#listing-count").textContent = new Intl.NumberFormat("pt-BR").format(items.length);
  document.querySelector("#min-title").textContent = minItem ? shortText(minItem.title, 32) : "nenhum preço disponível";
  document.querySelector("#max-title").textContent = maxItem ? shortText(maxItem.title, 32) : "nenhum preço disponível";
  document.querySelector("#result-count").textContent = "Exibindo " + items.length + " de " + Number(data.paging?.total || items.length).toLocaleString("pt-BR") + " anúncios encontrados";
  document.querySelector("#empty-results").hidden = items.length > 0;
  rowsEl.innerHTML = items.map((item) => {
    const picture = item.thumbnail ? '<img src="' + escapeHTML(item.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="image-placeholder">◇</span>';
    const condition = item.condition === "new" ? "Novo" : item.condition === "used" ? "Usado" : "Ver anúncio";
    const sellerId = item.seller?.id ? "Vendedor #" + escapeHTML(item.seller.id) : "—";
    const currentPrice = item.price !== null && item.price !== undefined && Number.isFinite(Number(item.price)) ? money.format(Number(item.price)) : "—";
    const hasRegularPrice = item.regular_price !== null && item.regular_price !== undefined && Number.isFinite(Number(item.regular_price)) && Number(item.regular_price) > Number(item.price);
    const priceMarkup = hasRegularPrice
      ? '<span class="price-current">' + currentPrice + '</span><small class="price-regular">' + money.format(Number(item.regular_price)) + '</small><span class="promo-label">PROMOÇÃO</span>'
      : '<span class="price-current">' + currentPrice + '</span>';
    return "<tr><td><div class=\"item\">" + picture + "<div><div class=\"item-title\">" + escapeHTML(item.title) + "</div><div class=\"item-id\">" + escapeHTML(item.id) + "</div></div></div></td><td class=\"price\">"  + priceMarkup + "</td><td><span class=\"condition\">" + condition + "</span></td><td class=\"seller\">" + sellerId + "</td><td><a class=\"open-link\" href=\"" + escapeHTML(item.permalink || "#") + "\" target=\"_blank\" rel=\"noreferrer\" aria-label=\"Abrir anúncio em nova aba\">↗</a></td></tr>";
  }).join("");
  resultsEl.hidden = false;
}
function shortText(value, max) { const text = String(value || ""); return text.length > max ? text.slice(0, max - 1) + "…" : text; }
form.addEventListener("submit", (event) => { event.preventDefault(); const query = input.value.trim(); if (query.length >= 2) search(query); });
document.querySelectorAll("[data-query]").forEach((chip) => chip.addEventListener("click", () => { input.value = chip.dataset.query; search(chip.dataset.query); }));
