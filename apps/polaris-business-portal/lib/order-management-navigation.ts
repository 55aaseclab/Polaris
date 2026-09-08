export type OrderIdentity = {
  order_no: string;
};

/** Keep a selected order only while it is present in the current list. */
export function resolveSelectedOrderNo(
  preferredOrderNo: string | null | undefined,
  orders: readonly OrderIdentity[],
): string | null {
  const preferred = preferredOrderNo?.trim();
  if (!preferred) return null;
  return orders.some((order) => order.order_no === preferred) ? preferred : null;
}
