import { supabase } from '../lib/supabase';

export async function createOrderHandler(customerId: string, totalCents: number): Promise<number> {
  const { data, error } = await supabase.schema('app').rpc('create_order', {
    p_customer: customerId,
    p_total: totalCents,
  });
  if (error) throw error;
  return data as number;
}

export async function cancelOrderHandler(orderId: number): Promise<void> {
  const { error } = await supabase
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId);
  if (error) throw error;
}
