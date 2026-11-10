const loadItemsButton = document.querySelector("#load-items");
const accountStatus = document.querySelector("#account-status");
const accountContent = document.querySelector("#account-content");
const accountRows = document.querySelector("#account-rows");
const activeTotal = document.querySelector("#active-total");
const pageTotal = document.querySelector("#page-total");
const stockTotal = document.querySelector("#stock-total");
const pageLabel = document.querySelector("#account-page-label");
const previousButton = document.querySelector("#items-prev");
const nextButton = document.querySelector("#items-next");
const scanNote = document.querySelector("#scan-note");
const accountMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const accountEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
let currentOffset = 0;
let accountPaging = null;
let loadingItems = false;

function setAccountStatus(message, kind = "") {
  accountStatus.textContent = message;
  accountStatus.className = "account-status" + (kind ? " " + kind : "");
}

function showAccountError(data, response) {
  const message = data?.error || "Não foi possível carregar seus anúncios.";
  let details = "";
  if (data?.upstream_status) details = " (API: " + data.upstream_status + ")";
  if (data?.request_id) details += " · ID: " + data.request_id;
  setAccountStatus(message + details, "error");
  if (response.status === 401 && data?.login_url) {
    const link = document.createElement("a");
    link.href = data.login_url;
    link.textContent = " Conectar conta";
    link.className = "inline-auth-link";
    accountStatus.append(link);
  }
}

function listingTypeLabel(type) {
  return ({ gold_special: "Clássico", gold_premium: "Premium", gold_pro: "Premium", gold: "Clássico" })[type] || type || "—";
}

async function loadAccountItems(offset = 0) {
  if (loadingItems) return;
  loadingItems = true;
  loadItemsButton.disabled = true;
  previousButton.disabled = true;
  nextButton.disabled = true;
  setAccountStatus("Buscando anúncios ativos na sua conta…");
  try {
    const response = await fetch("/api/my-items?offset=" + encodeURIComponent(offset), {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      setAccountStatus("O servidor respondeu com uma página inesperada (HTTP " + response.status + ").", "error");
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      showAccountError(data, response);
      return;
    }
    renderAccountItems(data);
    const seller = data.seller?.nickname ? "Conta " + data.seller.nickname + " · " : "";
    setAccountStatus(seller + "Dados atualizados agora.", "success");
  } catch {
    setAccountStatus("Falha de conexão ao carregar seus anúncios. Tente novamente.", "error");
  } finally {
    loadingItems = false;
    loadItemsButton.disabled = false;
    previousButton.disabled = !accountPaging || currentOffset === 0;
    nextButton.disabled = !accountPaging || !accountPaging.has_more || currentOffset >= 950;
  }
}

function renderAccountItems(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  accountPaging = data.paging || { total: items.length, limit: 50, offset: currentOffset, has_more: false };
  currentOffset = Number(accountPaging.offset) || 0;
  const total = Number(accountPaging.total || 0);
  const stock = items.reduce((sum, item) => sum + Math.max(0, Number(item.available_quantity) || 0), 0);

  activeTotal.textContent = new Intl.NumberFormat("pt-BR").format(total);
  pageTotal.textContent = new Intl.NumberFormat("pt-BR").format(items.length);
  stockTotal.textContent = new Intl.NumberFormat("pt-BR").format(stock);
  pageLabel.textContent = total
    ? "Anúncios " + (currentOffset + 1).toLocaleString("pt-BR") + "–" + (currentOffset + items.length).toLocaleString("pt-BR") + " de " + total.toLocaleString("pt-BR")
    : "Nenhum anúncio ativo encontrado";
  scanNote.hidden = !accountPaging.scan_required;

  accountRows.innerHTML = items.map((item) => {
    const picture = item.thumbnail
      ? '<img src="' + accountEsc(item.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : '<span class="account-image-placeholder">◇</span>';
    const quantity = item.available_quantity === null ? "—" : new Intl.NumberFormat("pt-BR").format(item.available_quantity);
    const stockClass = Number(item.available_quantity) === 0 ? "stock-empty" : "";
    const hasPrice = item.price !== null && item.price !== undefined && item.price !== "";
    const price = hasPrice && Number.isFinite(Number(item.price)) ? accountMoney.format(Number(item.price)) : "—";
    const link = item.permalink ? accountEsc(item.permalink) : "#";
    return '<tr><td><div class="account-item">' + picture + '<div><strong>' + accountEsc(item.title) + '</strong><small>' + accountEsc(item.id) + '</small></div></div></td>' +
      '<td class="account-price">' + price + '</td><td><span class="stock-value ' + stockClass + '">' + quantity + '</span></td>' +
      '<td>' + accountEsc(listingTypeLabel(item.listing_type_id)) + '</td>' +
      '<td><a class="open-link" href="' + link + '" target="_blank" rel="noreferrer" aria-label="Abrir anúncio em nova aba">↗</a></td></tr>';
  }).join("");

  accountContent.hidden = false;
  previousButton.disabled = currentOffset === 0;
  nextButton.disabled = !accountPaging.has_more || currentOffset >= 950;
}

loadItemsButton.addEventListener("click", () => loadAccountItems(0));
previousButton.addEventListener("click", () => loadAccountItems(Math.max(0, currentOffset - 50)));
nextButton.addEventListener("click", () => loadAccountItems(currentOffset + 50));

document.querySelectorAll(".side-link").forEach((link) => link.addEventListener("click", () => {
  document.querySelectorAll(".side-link").forEach((candidate) => candidate.classList.remove("active"));
  link.classList.add("active");
}));
