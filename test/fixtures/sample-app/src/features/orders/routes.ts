export const ordersRoutes = [
  { path: 'orders', lazy: async () => ({ Component: (await import('@/features/orders/OrdersPage')).OrdersPage }) },
  { path: 'orders/:id', lazy: async () => ({ Component: (await import('@/features/orders/OrderDetailPage')).OrderDetailPage }) },
];
