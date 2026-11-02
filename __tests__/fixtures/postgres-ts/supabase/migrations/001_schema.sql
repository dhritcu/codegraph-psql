-- Shop schema: customers place orders; an order's status is an enum.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');

CREATE TYPE app.address AS (
  street text,
  city text,
  postal_code text
);

CREATE DOMAIN public.email AS text
  CHECK (VALUE ~* '^[^@]+@[^@]+$');

CREATE SEQUENCE app.invoice_number_seq START 1000;

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email email NOT NULL UNIQUE,
  shipping_address app.address,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  status order_status NOT NULL DEFAULT 'pending',
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  price_cents integer NOT NULL
);

CREATE TABLE app.order_items (
  order_id bigint NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, sku),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES public.orders (id)
);

CREATE INDEX orders_customer_idx ON orders (customer_id);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY orders_owner ON orders
  USING (customer_id = current_setting('app.customer_id')::uuid);
