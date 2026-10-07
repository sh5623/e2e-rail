import { Table } from '@/components/Table';
import { listOrders } from './services/orders';
export const OrdersPage = async () => Table(await listOrders());
