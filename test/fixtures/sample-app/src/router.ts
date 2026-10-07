import { ordersRoutes } from '@/features/orders/routes';
import { cartRoutes } from '@/features/cart/routes';
export const router = [{
  path: '/app',
  lazy: async () => ({ Component: (await import('@/features/home/HomePage')).HomePage }),
  children: [...ordersRoutes, ...cartRoutes],
}];
