export const cartRoutes = [
  { path: 'cart', lazy: async () => ({ Component: (await import('@/features/cart/CartPage')).CartPage }) },
];
