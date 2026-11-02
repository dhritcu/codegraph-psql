-- Every new order leaves an audit row.
CREATE TABLE app.audit (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL,
  logged_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION app.log_order_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.audit (order_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_audit
  AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION app.log_order_insert();
