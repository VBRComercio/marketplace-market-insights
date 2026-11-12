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
let accountItems = [];
const accountSort = document.querySelector("#account-sort");
const performanceButton = document.querySelector("#load-performance");
const performanceDays = document.querySelector("#performance-days");
const performanceStatus = document.querySelector("#performance-status");
const performanceSummary = document.querySelector("#performance-summary");
const performanceRows = document.querySelector("#performance-rows");
const periodVisits = document.querySelector("#period-visits");
const periodUnits = document.querySelector("#period-units");
const periodGross = document.querySelector("#period-gross");
let performanceByItem = new Map();
let loadingPerformance = false;
const marginButton = document.querySelector("#load-margin-analysis");
const analysisStatus = document.querySelector("#analysis-status");
const analysisSummary = document.querySelector("#analysis-summary");
const analysisTotalPayout = document.querySelector("#analysis-total-payout");
const analysisTotalMargin = document.querySelector("#analysis-total-margin");
const analysisStockValue = document.querySelector("#analysis-stock-value");
const marginRows = document.querySelector("#margin-rows");
const ratesForm = document.querySelector("#analysis-rates-form");
const costForm = document.querySelector("#analysis-cost-form");
const mappingForm = document.querySelector("#analysis-mapping-form");
const mappingItemSelect = document.querySelector("#mapping-item");
const mappingSkuInput = document.querySelector("#mapping-sku");
const costSkuInput = document.querySelector("#cost-sku");
let analysisConfig = null;
let marginByItem = new Map();
let loadingAnalysisConfig = false;
let loadingMarginAnalysis = false;

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
    performanceByItem = new Map();
    performanceSummary.hidden = true;
    performanceStatus.textContent = "Escolha um período e clique em Consultar desempenho.";
    performanceStatus.className = "account-status";
    renderAccountItems(data);
    await loadAnalysisConfig();
    const seller = data.seller?.nickname ? "Conta " + data.seller.nickname + " · " : "";
    const missingPrices = Number(data.pricing_unavailable_count || 0);
    setAccountStatus(seller + (missingPrices ? missingPrices + " preço(s) vigente(s) não retornado(s) pela API." : "Preços de venda atuais consultados no canal Mercado Livre."), missingPrices ? "warning" : "success");
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
  accountItems = items;
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

  const sortedItems = [...items].sort((a, b) => compareAccountItems(a, b, accountSort?.value || "title"));
  accountRows.innerHTML = sortedItems.map((item) => {
    const picture = item.thumbnail
      ? '<img src="' + accountEsc(item.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : '<span class="account-image-placeholder">◇</span>';
    const quantity = item.available_quantity === null ? "—" : new Intl.NumberFormat("pt-BR").format(item.available_quantity);
    const stockClass = Number(item.available_quantity) === 0 ? "stock-empty" : "";
    const hasPrice = item.price !== null && item.price !== undefined && item.price !== "";
    const price = hasPrice && Number.isFinite(Number(item.price)) ? accountMoney.format(Number(item.price)) : "Preço vigente indisponível";
    const hasPromo = item.is_promotional && item.regular_price !== null && Number.isFinite(Number(item.regular_price));
    const priceMarkup = hasPromo
      ? '<strong class="price-current">' + price + '</strong><small class="price-regular">' + accountMoney.format(Number(item.regular_price)) + '</small><span class="promo-label">PROMOÇÃO</span>'
      : hasPrice ? '<strong class="price-current">' + price + '</strong>' : '<small class="price-unavailable">Preço de venda não retornado</small>';
    const link = item.permalink ? accountEsc(item.permalink) : "#";
    const metrics = performanceByItem.get(item.id);
    const visits = metrics?.visits === null ? "N/D" : metrics?.visits === undefined ? "—" : new Intl.NumberFormat("pt-BR").format(metrics.visits);
    const unitsSold = metrics?.units_sold === null ? "N/D" : metrics?.units_sold === undefined ? "—" : new Intl.NumberFormat("pt-BR").format(metrics.units_sold);
    const grossSales = metrics?.gross_sales === null ? "N/D" : metrics?.gross_sales === undefined ? "—" : accountMoney.format(metrics.gross_sales);
    return '<tr><td><div class="account-item">' + picture + '<div><strong>' + accountEsc(item.title) + '</strong><small>' + accountEsc(item.id) + '</small></div></div></td>' +
      '<td class="account-price">' + priceMarkup + '</td><td><span class="stock-value ' + stockClass + '">' + quantity + '</span></td>' +
      '<td>' + accountEsc(listingTypeLabel(item.listing_type_id)) + '</td>' +
      '<td>' + visits + '</td><td>' + unitsSold + '</td><td>' + grossSales + '</td>' +
      '<td><a class="open-link" href="' + link + '" target="_blank" rel="noreferrer" aria-label="Abrir anúncio em nova aba">↗</a></td></tr>';
  }).join("");

  accountContent.hidden = false;
  renderPerformanceRows();
  renderMarginTable();
  previousButton.disabled = currentOffset === 0;
  nextButton.disabled = !accountPaging.has_more || currentOffset >= 950;
}


function renderPerformanceRows() {
  if (!performanceRows) return;
  performanceRows.innerHTML = accountItems.map((item) => {
    const metrics = performanceByItem.get(item.id);
    const visits = metrics?.visits === null ? "N/D" : metrics?.visits === undefined ? "—" : new Intl.NumberFormat("pt-BR").format(metrics.visits);
    const units = metrics?.units_sold === null ? "N/D" : metrics?.units_sold === undefined ? "—" : new Intl.NumberFormat("pt-BR").format(metrics.units_sold);
    const gross = metrics?.gross_sales === null ? "N/D" : metrics?.gross_sales === undefined ? "—" : accountMoney.format(metrics.gross_sales);
    const link = item.permalink ? accountEsc(item.permalink) : "#";
    return '<tr><td><div class="account-item"><div><strong>' + accountEsc(item.title) + '</strong><small>' + accountEsc(item.id) + '</small></div></div></td>' +
      '<td>' + visits + '</td><td>' + units + '</td><td>' + gross + '</td>' +
      '<td><a class="open-link" href="' + link + '" target="_blank" rel="noreferrer" aria-label="Abrir anúncio em nova aba">↗</a></td></tr>';
  }).join("");
}

function compareAccountItems(a, b, mode) {
  const titleCompare = String(a.title || "").localeCompare(String(b.title || ""), "pt-BR", { sensitivity: "base" });
  const priceA = Number.isFinite(Number(a.price)) && a.price !== null && a.price !== "" ? Number(a.price) : null;
  const priceB = Number.isFinite(Number(b.price)) && b.price !== null && b.price !== "" ? Number(b.price) : null;
  const stockA = Number(a.available_quantity) || 0;
  const stockB = Number(b.available_quantity) || 0;
  if (mode === "price-asc" || mode === "price-desc") {
    if (priceA === null) return priceB === null ? titleCompare : 1;
    if (priceB === null) return -1;
    return (priceA - priceB) * (mode === "price-asc" ? 1 : -1) || titleCompare;
  }
  if (mode === "stock-asc" || mode === "stock-desc") return (stockA - stockB) * (mode === "stock-asc" ? 1 : -1) || titleCompare;
  return titleCompare;
}

accountSort?.addEventListener("change", () => {
  if (accountItems.length) {
    accountRows.innerHTML = "";
    const currentData = { items: accountItems, paging: accountPaging };
    renderAccountItems(currentData);
  }
});

async function loadPerformance() {
  if (loadingPerformance) return;
  if (!accountPaging) {
    performanceStatus.textContent = "Carregue os anúncios antes de consultar o desempenho.";
    performanceStatus.className = "account-status warning";
    return;
  }
  loadingPerformance = true;
  performanceButton.disabled = true;
  performanceStatus.textContent = "Consultando visitas e pedidos pagos no Mercado Livre…";
  performanceStatus.className = "account-status";
  try {
    const days = Number(performanceDays.value);
    const response = await fetch("/api/performance?offset=" + encodeURIComponent(currentOffset) + "&days=" + encodeURIComponent(days), {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      performanceStatus.textContent = "O servidor respondeu com uma página inesperada (HTTP " + response.status + ").";
      performanceStatus.className = "account-status error";
      return;
    }
    const data = await response.json();
    if (!response.ok) {
      performanceStatus.textContent = (data?.error || "Não foi possível consultar o desempenho.") + (data?.request_id ? " · ID: " + data.request_id : "");
      performanceStatus.className = "account-status error";
      if (response.status === 401 && data?.login_url) {
        const link = document.createElement("a");
        link.href = data.login_url;
        link.textContent = " Reconectar conta";
        link.className = "inline-auth-link";
        performanceStatus.append(link);
      }
      return;
    }
    performanceByItem = new Map((Array.isArray(data.items) ? data.items : []).map((item) => [item.id, item]));
    performanceSummary.hidden = false;

    let processedOrders = Number(data.orders?.scanned || 0);
    let nextOrderOffset = data.sales_error ? null : data.orders?.next_offset;
    let ordersWarning = data.sales_error || "";
    while (nextOrderOffset !== null && nextOrderOffset !== undefined && !ordersWarning) {
      performanceStatus.textContent = "Consultando pedidos: " + processedOrders.toLocaleString("pt-BR") + " de " + Number(data.orders?.total || 0).toLocaleString("pt-BR") + "…";
      const params = new URLSearchParams({
        days: String(days),
        offset: String(nextOrderOffset),
        date_from: String(data.date_from || ""),
        date_to: String(data.date_to || "")
      });
      const continuationResponse = await fetch("/api/performance-orders?" + params.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      const continuationType = continuationResponse.headers.get("content-type") || "";
      if (!continuationType.toLowerCase().includes("application/json")) {
        ordersWarning = "O servidor retornou uma resposta inesperada ao continuar os pedidos (HTTP " + continuationResponse.status + ").";
        break;
      }
      const continuation = await continuationResponse.json();
      if (!continuationResponse.ok) {
        ordersWarning = continuation?.error || "Não foi possível completar a consulta de pedidos.";
        break;
      }
      for (const [itemId, sales] of Object.entries(continuation.sales_by_item || {})) {
        const current = performanceByItem.get(itemId);
        if (!current) continue;
        performanceByItem.set(itemId, {
          ...current,
          units_sold: (Number(current.units_sold) || 0) + (Number(sales.units) || 0),
          gross_sales: Math.round(((Number(current.gross_sales) || 0) + (Number(sales.gross) || 0)) * 100) / 100
        });
      }
      const scannedNow = Number(continuation.orders?.scanned || 0);
      processedOrders += scannedNow;
      const followingOffset = continuation.orders?.next_offset;
      if (!scannedNow && followingOffset !== null && followingOffset !== undefined) {
        ordersWarning = "A consulta não avançou na paginação dos pedidos.";
        break;
      }
      nextOrderOffset = followingOffset;
    }

    if (!data.sales_error) {
      data.orders = { ...(data.orders || {}), scanned: processedOrders, partial: nextOrderOffset !== null && nextOrderOffset !== undefined, next_offset: nextOrderOffset };
      data.totals.units_sold = [...performanceByItem.values()].reduce((sum, item) => sum + (Number(item.units_sold) || 0), 0);
      data.totals.gross_sales = Math.round([...performanceByItem.values()].reduce((sum, item) => sum + (Number(item.gross_sales) || 0), 0) * 100) / 100;
    }
    renderAccountItems({ items: accountItems, paging: accountPaging });
    renderPerformanceRows();

    const formatNumber = (value) => value === null || value === undefined ? "N/D" : new Intl.NumberFormat("pt-BR").format(value);
    periodVisits.textContent = formatNumber(data.totals?.visits) + (data.visits_partial ? " · parcial" : "");
    periodUnits.textContent = formatNumber(data.totals?.units_sold) + (data.orders?.partial && data.totals?.units_sold !== null ? " · parcial" : "");
    periodGross.textContent = data.totals?.gross_sales === null || data.totals?.gross_sales === undefined ? "N/D" : accountMoney.format(data.totals.gross_sales) + (data.orders?.partial ? " · parcial" : "");

    const warnings = [];
    if (ordersWarning) warnings.push("Vendas: " + ordersWarning);
    if (data.visits_error) warnings.push(data.visits_error);
    if (data.visits_partial && !data.visits_error) warnings.push("A API não retornou visitas para todos os anúncios desta página.");
    if (data.orders?.partial) warnings.push("Pedidos consultados parcialmente: " + Number(data.orders.scanned || 0).toLocaleString("pt-BR") + " de " + Number(data.orders.total || 0).toLocaleString("pt-BR") + ".");
    const seller = data.seller?.nickname ? "Conta " + data.seller.nickname + " · " : "";
    const dateLabel = data.date_from && data.date_to
      ? " (" + new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date(data.date_from)) + " a " + new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(new Date(data.date_to)) + ")"
      : "";
    performanceStatus.textContent = seller + "Período de " + days + " dias consultado" + dateLabel + "." + (warnings.length ? " " + warnings.join(" ") : "");
    performanceStatus.className = "account-status" + (warnings.length ? " warning" : " success");
    renderMarginTable();
  } catch {
    performanceStatus.textContent = "Falha de conexão ao consultar vendas e visitas.";
    performanceStatus.className = "account-status error";
  } finally {
    loadingPerformance = false;
    performanceButton.disabled = false;
  }
}

async function loadAnalysisConfig() {
  if (loadingAnalysisConfig || !accountItems.length) return;
  loadingAnalysisConfig = true;
  setAnalysisStatus("Carregando cadastro de custos e percentuais…");
  try {
    const params = new URLSearchParams({ item_ids: accountItems.map((item) => item.id).join(",") });
    const response = await fetch("/api/analysis-config?" + params.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível carregar o cadastro.");
    analysisConfig = data;
    fillAnalysisForms();
    renderAnalysisHistory();
    setAnalysisStatus("Cadastro carregado. Parâmetros gerais aplicam-se ao CNPJ; custos e lotes são vinculados ao SKU.", "success");
    renderMarginTable();
  } catch (error) {
    setAnalysisStatus(error.message || "Falha ao carregar o cadastro.", "warning");
  } finally {
    loadingAnalysisConfig = false;
  }
}

function todayInBrazil() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function setAnalysisStatus(message, kind = "") {
  if (!analysisStatus) return;
  analysisStatus.textContent = message;
  analysisStatus.className = "account-status" + (kind ? " " + kind : "");
}

function fillAnalysisForms() {
  if (!analysisConfig) return;
  const rates = analysisConfig.rates || {};
  document.querySelector("#rate-effective-from").value = rates.effective_from || todayInBrazil();
  document.querySelector("#rate-nf").value = rates.nf_percent ?? 4;
  document.querySelector("#rate-ads").value = rates.ads_percent ?? 2.5;
  document.querySelector("#rate-defects").value = rates.defect_percent ?? 2;
  document.querySelector("#rate-operational").value = rates.operational_percent ?? 5;
  document.querySelector("#rate-stock-alert").value = rates.stock_alert_days ?? 7;
  document.querySelector("#cost-effective-from").value = todayInBrazil();

  const previousItem = mappingItemSelect.value;
  const previousCostSku = costSkuInput.value;
  const mappings = new Map((analysisConfig.mappings || []).map((entry) => [entry.item_id, entry.sku]));
  mappingItemSelect.innerHTML = '<option value="">Selecione um anúncio</option>' + accountItems.map((item) =>
    '<option value="' + accountEsc(item.id) + '">' + accountEsc(item.title) + ' (' + accountEsc(item.id) + ')</option>'
  ).join("");
  if (accountItems.some((item) => item.id === previousItem)) mappingItemSelect.value = previousItem;
  else if (accountItems.length) mappingItemSelect.value = accountItems[0].id;
  populateMappingSku(mappings);

  const selectedSku = previousCostSku || mappingSkuInput.value;
  if (!costSkuInput.value) costSkuInput.value = selectedSku;
  populateCostBySku();
}

function populateMappingSku(mappings = new Map((analysisConfig?.mappings || []).map((entry) => [entry.item_id, entry.sku]))) {
  const selected = accountItems.find((item) => item.id === mappingItemSelect.value);
  if (!selected) {
    mappingSkuInput.value = "";
    return;
  }
  mappingSkuInput.value = mappings.get(selected.id) || selected.seller_sku || "";
}

function populateCostBySku() {
  if (!analysisConfig) return;
  const sku = costSkuInput.value.trim();
  const latest = (analysisConfig.latest_costs || []).find((cost) => cost.sku === sku);
  if (latest) {
    document.querySelector("#cost-unit").value = latest.unit_cost;
    document.querySelector("#cost-packaging").value = latest.packaging_cost;
  } else {
    document.querySelector("#cost-unit").value = "";
    document.querySelector("#cost-packaging").value = "0.50";
  }
  document.querySelector("#cost-lot").value = "";
}
function renderAnalysisHistory() {
  const target = document.querySelector("#analysis-history");
  if (!target || !analysisConfig) return;
  const rates = analysisConfig.rates_history || [];
  const costs = analysisConfig.costs_history || [];
  const ratesMarkup = rates.length
    ? '<ul>' + rates.map((entry) => '<li>' + accountEsc(entry.effective_from) + ': NF ' + accountEsc(entry.nf_percent) + '%, Ads ' + accountEsc(entry.ads_percent) + '%, defeitos ' + accountEsc(entry.defect_percent) + '%, operação ' + accountEsc(entry.operational_percent) + '%, alerta de estoque ' + accountEsc(entry.stock_alert_days) + ' dias</li>').join("") + '</ul>'
    : '<p>Nenhuma versão de parâmetros salva.</p>';
  const costsMarkup = costs.length
    ? '<ul>' + costs.map((entry) => '<li>SKU ' + accountEsc(entry.sku) + (entry.lot_code ? ' · lote ' + accountEsc(entry.lot_code) : "") + ' · desde ' + accountEsc(entry.effective_from) + ' · produto ' + accountMoney.format(Number(entry.unit_cost)) + ' · embalagem ' + accountMoney.format(Number(entry.packaging_cost)) + '</li>').join("") + '</ul>'
    : '<p>Nenhum custo por SKU/lote salvo.</p>';
  target.innerHTML = '<h5>Parâmetros gerais do CNPJ</h5>' + ratesMarkup + '<h5>Custos por SKU e lote</h5>' + costsMarkup;
}

async function saveAnalysisForm(form, payload, successMessage) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  setAnalysisStatus("Salvando cadastro…");
  try {
    const response = await fetch("/api/analysis-config", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível salvar.");
    await loadAnalysisConfig();
    setAnalysisStatus(successMessage + " Vigência: " + data.effective_from + ".", "success");
  } catch (error) {
    setAnalysisStatus(error.message || "Falha ao salvar o cadastro.", "error");
  } finally {
    button.disabled = false;
  }
}

ratesForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAnalysisForm(ratesForm, {
    type: "rates",
    effective_from: document.querySelector("#rate-effective-from").value,
    nf_percent: document.querySelector("#rate-nf").value,
    ads_percent: document.querySelector("#rate-ads").value,
    defect_percent: document.querySelector("#rate-defects").value,
    operational_percent: document.querySelector("#rate-operational").value,
    stock_alert_days: document.querySelector("#rate-stock-alert").value
  }, "Parâmetros gerais salvos para todo o CNPJ.");
});

mappingItemSelect?.addEventListener("change", () => populateMappingSku());
mappingForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAnalysisForm(mappingForm, {
    type: "sku_mapping",
    item_id: mappingItemSelect.value,
    sku: mappingSkuInput.value
  }, "Anúncio vinculado ao SKU. Esse SKU pode estar associado a outros anúncios.");
});
costSkuInput?.addEventListener("change", populateCostBySku);
costForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAnalysisForm(costForm, {
    type: "sku_cost",
    sku: costSkuInput.value,
    lot_code: document.querySelector("#cost-lot").value,
    effective_from: document.querySelector("#cost-effective-from").value,
    unit_cost: document.querySelector("#cost-unit").value,
    packaging_cost: document.querySelector("#cost-packaging").value
  }, "Custo do SKU/lote salvo.");
});

async function loadMarginAnalysis() {
  if (loadingMarginAnalysis || !accountItems.length) return;
  loadingMarginAnalysis = true;
  marginButton.disabled = true;
  marginByItem = new Map();
  setAnalysisStatus("Consultando tarifas e frete estimado na API do Mercado Livre…");
  try {
    const results = [];
    for (let start = 0; start < accountItems.length; start += 20) {
      setAnalysisStatus("Calculando " + Math.min(start + 20, accountItems.length).toLocaleString("pt-BR") + " de " + accountItems.length.toLocaleString("pt-BR") + " anúncios…");
      const response = await fetch("/api/margin-estimates", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ items: accountItems.slice(start, start + 20) })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Não foi possível calcular as margens.");
      results.push(...(data.results || []));
    }
    marginByItem = new Map(results.map((entry) => [entry.id, entry]));
    renderMarginTable();
    const incomplete = results.filter((entry) => entry.missing?.length).length;
    setAnalysisStatus(incomplete
      ? "Análise concluída. " + incomplete + " anúncio(s) têm dados pendentes; veja os detalhes nas linhas."
      : "Análise concluída. Repasse e frete são estimativas da API para o contexto atual.", incomplete ? "warning" : "success");
  } catch (error) {
    setAnalysisStatus(error.message || "Falha ao consultar tarifas e frete.", "error");
  } finally {
    loadingMarginAnalysis = false;
    marginButton.disabled = false;
  }
}

function renderMarginTable() {
  if (!marginRows || !accountItems.length) return;
  const formatValue = (value) => value === null || value === undefined ? "N/D" : accountMoney.format(Number(value));
  const rows = accountItems.map((item) => {
    const analysis = marginByItem.get(item.id);
    const metrics = performanceByItem.get(item.id);
    const quantity = item.available_quantity === null || item.available_quantity === undefined ? null : Number(item.available_quantity);
    const units = metrics?.units_sold === null || metrics?.units_sold === undefined ? null : Number(metrics.units_sold);
    const periodDays = Number(performanceDays?.value) || 30;
    const dailySales = units === null ? null : units / periodDays;
    const coverage = dailySales === null ? "Consulte desempenho" : dailySales > 0 ? quantity === null ? "N/D" : (quantity / dailySales).toFixed(1).replace(".", ",") + " dias" : "Sem vendas";
    const coverageValue = dailySales > 0 && quantity !== null ? quantity / dailySales : null;
    const alertDays = Number(analysisConfig?.rates?.stock_alert_days ?? 7);
    const coverageClass = coverageValue !== null && coverageValue <= alertDays ? "low-stock" : coverageValue !== null ? "good-stock" : "";
    const stockValue = quantity !== null && analysis?.unit_cost !== null && analysis?.unit_cost !== undefined ? quantity * Number(analysis.unit_cost) : null;
    const missingTitle = analysis?.missing?.length ? '<small>' + accountEsc(analysis.missing.join(" ")) + '</small>' : "";
    const payout = analysis?.contribution_margin;
    const estimated = analysis?.estimated_margin;
    const details = analysis ? '<small>SKU ' + accountEsc(analysis.sku || "não vinculado") + '</small>' : '<small>Atualize a análise</small>';
    return '<tr><td><strong>' + accountEsc(item.title) + '</strong><small>' + accountEsc(item.id) + '</small>' + details + missingTitle + '</td>' +
      '<td>' + formatValue(payout) + '</td><td>' + formatValue(analysis?.sale_fee) + '</td><td>' + formatValue(analysis?.seller_shipping) + '</td>' +
      '<td>' + (analysis?.unit_cost === null || analysis?.unit_cost === undefined ? "N/D" : formatValue(Number(analysis.unit_cost) + Number(analysis.packaging_cost || 0))) + '</td>' +
      '<td>' + formatValue(estimated) + '</td><td>' + (quantity === null ? "N/D" : new Intl.NumberFormat("pt-BR").format(quantity)) + '</td>' +
      '<td class="' + coverageClass + '">' + accountEsc(coverage) + '</td><td>' + formatValue(stockValue) + '</td></tr>';
  });
  marginRows.innerHTML = rows.join("");

  if (!marginByItem.size) {
    analysisTotalPayout.textContent = "—";
    analysisTotalMargin.textContent = "—";
    analysisStockValue.textContent = "—";
    const lowStockElement = document.querySelector("#analysis-low-stock-count");
    if (lowStockElement) lowStockElement.textContent = "—";
    analysisSummary.hidden = true;
    return;
  }
  const completePayout = accountItems.length > 0 && accountItems.every((item) => marginByItem.get(item.id)?.contribution_margin !== null && marginByItem.get(item.id)?.contribution_margin !== undefined);
  const completeMargin = accountItems.length > 0 && accountItems.every((item) => marginByItem.get(item.id)?.estimated_margin !== null && marginByItem.get(item.id)?.estimated_margin !== undefined);
  const knownStock = accountItems.reduce((sum, item) => {
    const entry = marginByItem.get(item.id);
    return sum + (item.available_quantity !== null && item.available_quantity !== undefined && entry?.unit_cost !== null && entry?.unit_cost !== undefined ? Number(item.available_quantity) * Number(entry.unit_cost) : 0);
  }, 0);
  const completeStock = accountItems.every((item) => item.available_quantity !== null && item.available_quantity !== undefined && marginByItem.get(item.id)?.unit_cost !== null && marginByItem.get(item.id)?.unit_cost !== undefined);
  analysisTotalPayout.textContent = completePayout ? formatValue(accountItems.reduce((sum, item) => sum + Number(marginByItem.get(item.id).contribution_margin), 0)) : "Dados parciais";
  analysisTotalMargin.textContent = completeMargin ? formatValue(accountItems.reduce((sum, item) => sum + Number(marginByItem.get(item.id).estimated_margin), 0)) : "Dados parciais";
  analysisStockValue.textContent = marginByItem.size ? formatValue(knownStock) + (completeStock ? "" : " · parcial") : "—";
  const lowStockCount = accountItems.filter((item) => {
    const metrics = performanceByItem.get(item.id);
    const qty = item.available_quantity === null || item.available_quantity === undefined ? null : Number(item.available_quantity);
    const soldUnits = metrics?.units_sold;
    const daily = soldUnits === null || soldUnits === undefined ? null : Number(soldUnits) / (Number(performanceDays?.value) || 30);
    return daily > 0 && qty !== null && Number.isFinite(qty) && qty / daily <= Number(analysisConfig?.rates?.stock_alert_days ?? 7);
  }).length;
  const lowStockElement = document.querySelector("#analysis-low-stock-count");
  if (lowStockElement) lowStockElement.textContent = performanceByItem.size ? String(lowStockCount) : "Consulte desempenho";
  analysisSummary.hidden = false;
}

marginButton?.addEventListener("click", loadMarginAnalysis);
performanceButton.addEventListener("click", loadPerformance);

loadItemsButton.addEventListener("click", () => loadAccountItems(0));
previousButton.addEventListener("click", () => loadAccountItems(Math.max(0, currentOffset - 50)));
nextButton.addEventListener("click", () => loadAccountItems(currentOffset + 50));

const pageNames = {
  market: "Visão de mercado",
  items: "Meus anúncios",
  performance: "Vendas e visitas",
  analysis: "Margem e estoque"
};
function activatePage(name) {
  const page = pageNames[name] ? name : "market";
  document.querySelectorAll("[data-page-view]").forEach((view) => {
    const active = view.dataset.pageView === page;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll(".side-link[data-page]").forEach((link) => {
    const active = link.dataset.page === page;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const title = document.querySelector(".breadcrumb strong");
  if (title) title.textContent = pageNames[page];
  if ((page === "performance" || page === "analysis") && !accountPaging) {
    const status = document.querySelector(page === "performance" ? "#performance-page-context" : "#analysis-page-context");
    if (status) status.textContent = "Carregando seus anúncios para preparar esta página…";
    loadAccountItems(0);
  }
}
const pageFromHash = () => ({
  "#visao-mercado": "market",
  "#meus-anuncios": "items",
  "#desempenho": "performance",
  "#margem-estoque": "analysis"
})[window.location.hash] || "market";
window.addEventListener("hashchange", () => activatePage(pageFromHash()));
activatePage(pageFromHash());
