import { sql } from '../lib/sql';
import { pool } from '../lib/pool';

export async function placeOrderHandler(customerId: string, totalCents: number): Promise<number> {
  const [row] = await sql`
    INSERT INTO orders (customer_id, total_cents)
    VALUES (${customerId}, ${totalCents})
    RETURNING id
  `;
  return row.id as number;
}

export async function customerOrdersHandler(customerId: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    'SELECT id, status, total_cents FROM orders WHERE customer_id = $1 ORDER BY id',
    [customerId]
  );
  return rows;
}

export async function markPaidHandler(orderId: number): Promise<void> {
  await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['paid', orderId]);
}
