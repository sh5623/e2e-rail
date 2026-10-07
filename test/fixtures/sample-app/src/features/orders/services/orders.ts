export const listOrders = async () => fetch('/api/orders/list').then((r) => r.json() as Promise<unknown[]>);
export const getOrder = async (id: string) => fetch(`/api/orders/${id}`).then((r) => r.json());
