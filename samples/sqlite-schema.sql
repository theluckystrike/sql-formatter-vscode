-- SQLite schema
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS [order items] (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, sku TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0));
CREATE TABLE kv (k TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_items_order ON [order items](order_id);
INSERT INTO kv (k, v) VALUES ('schema', X'0A0B'), ('note', 'it''s fine');
