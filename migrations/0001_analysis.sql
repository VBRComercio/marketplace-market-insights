CREATE TABLE IF NOT EXISTS account_rate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  nf_percent REAL NOT NULL,
  ads_percent REAL NOT NULL,
  defect_percent REAL NOT NULL,
  operational_percent REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (seller_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_account_rate_history_effective
  ON account_rate_history (seller_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS listing_sku_map (
  seller_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (seller_id, item_id)
);

CREATE TABLE IF NOT EXISTS sku_cost_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  lot_code TEXT NOT NULL DEFAULT '',
  effective_from TEXT NOT NULL,
  unit_cost REAL NOT NULL,
  packaging_cost REAL NOT NULL DEFAULT 0,
  lot_quantity INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (seller_id, sku, lot_code, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_sku_cost_history_effective
  ON sku_cost_history (seller_id, sku, effective_from DESC);
