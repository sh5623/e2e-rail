import { getOrder } from './services/orders';
export const OrderDetailPage = (id: string) => getOrder(id);
