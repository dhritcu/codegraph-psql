CREATE VIEW app.open_orders AS
  SELECT o.id, o.total_cents, c.email
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
  WHERE o.status IN ('pending', 'paid');

CREATE MATERIALIZED VIEW app.customer_revenue AS
  SELECT customer_id, sum(total_cents) AS revenue
  FROM public.orders
  GROUP BY customer_id;

CREATE TABLE app.archived_orders (
  archived_at timestamptz NOT NULL DEFAULT now()
) INHERITS (public.orders);

ALTER TABLE ONLY app.order_items
  ADD CONSTRAINT order_items_sku_fk FOREIGN KEY (sku) REFERENCES app.products (sku);

COMMENT ON TABLE orders IS 'One row per customer order.';
