CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_touch
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION customer_total(p_customer uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(total_cents), 0) FROM orders WHERE customer_id = p_customer;
$$;

CREATE FUNCTION app.create_order(p_customer uuid, p_total integer) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO orders (customer_id, total_cents) VALUES (p_customer, p_total)
  RETURNING id INTO v_id;
  RAISE NOTICE 'customer total is now %', customer_total(p_customer);
  RETURN v_id;
END;
$$;

CREATE PROCEDURE app.cancel_order(p_order bigint)
LANGUAGE sql AS $$
  UPDATE orders SET status = 'cancelled' WHERE id = p_order;
$$;
