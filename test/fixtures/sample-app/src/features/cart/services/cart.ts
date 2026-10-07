export const addToCart = async (id: string) => fetch('/api/cart/add', { method: 'POST', body: id });
