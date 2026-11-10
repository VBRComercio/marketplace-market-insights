const form = document.querySelector("#search-form");
const input = document.querySelector("#query");
const button = document.querySelector("#search-button");
const statusEl = document.querySelector("#status");
const resultsEl = document.querySelector("#results");
const rowsEl = document.querySelector("#listing-rows");
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const showError = (message) => { statusEl.textContent = message; statusEl.className = "status error"; };

async function search(query) {
  button.disabled = true;
  button.innerHTML = "Buscando <span>…</span>";
  statusEl.className = "status";
  statusEl.textContent = "Consultando anúncios no Mercado Livre…";
  resultsEl.hidden = true;
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Não foi possível consultar a API agora.");
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
  document.querySelector("#result-heading").textContent = `“${query}”`;
  document.querySelector("#avg-price").textContent = average === null ? "—" : money.format(average);
  document.querySelector("#min-price").textContent = minItem ? money.format(Number(minItem.price)) : "—";
  document.querySelector("#max-price").textContent = maxItem ? money.format(Number(maxItem.price)) : "—";
  document.querySelector("#listing-count").textContent = new Intl.NumberFormat("pt-BR").format(items.length);
  document.querySelector("#min-title").textContent = minItem ? shortText(minItem.title, 32) : "nenhum preço disponível";
  document.querySelector("#max-title").textContent = maxItem ? shortText(maxItem.title, 32) : "nenhum preço disponível";
  document.querySelector("#result-count").textContent = `Exibindo ${items.length} de ${Number(data.paging?.total || items.length).toLocaleString("pt-BR")} anúncios encontrados`;
  document.querySelector("#empty-results").hidden = items.length > 0;
  rowsEl.innerHTML = items.map((item) => {
    const picture = item.thumbnail ? `<img src="${escapeHTML(item.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="image-placeholder">◇</span>';
    const condition = item.condition === "new" ? "Novo" : item.condition === "used" ? "Usado" : "Ver anúncio";
    return `<tr><td><div class="item">${picture}<div><div class="item-title">${escapeHTML(item.title)}</div><div class="item-id">${escapeHTML(item.id)}</div></div></div></td><td class="price">${Number.isFinite(Number(item.price)) ? money.format(Number(item.price)) : "—"}</td><td><span class="condition">${condition}</span></td><td class="seller">${item.seller?.id ? `Vendedor #${escapeHTML(item.seller.id)}` : "—"}</td><td><a class="open-link" href="${escapeHTML(item.permalink || "#")}" target="_blank" rel="noreferrer" aria-label="Abrir anúncio em nova aba">↗</a></td></tr>`;
  }).join("");
  resultsEl.hidden = false;
}
function shortText(value, max) { const text = String(value || ""); return text.length > max ? text.slice(0, max - 1) + "…" : text; }
form.addEventListener("submit", (event) => { event.preventDefault(); const query = input.value.trim(); if (query.length >= 2) search(query); });
document.querySelectorAll("[data-query]").forEach((chip) => chip.addEventListener("click", () => { input.value = chip.dataset.query; search(chip.dataset.query); }));
