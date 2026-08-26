-- OPTIONAL, and destructive: drops market_pages.currency.
--
-- The column was never read. The public market page uses the site-wide currency
-- store ($lib/currency) and the global selector, never the page's own value, so
-- the admin's "Currency" field wrote a column nothing consumed — a control that
-- looked meaningful and was not. That field and every code reference to the
-- column are now gone, so the column is inert whether or not you run this.
--
-- Run it only if you want the schema tidy. There is no functional gain, and a
-- dropped column cannot be recovered without a restore. If a per-market pricing
-- requirement ever appears, it should be designed deliberately rather than
-- resurrected from this vestigial field.

alter table market_pages drop column if exists currency;
