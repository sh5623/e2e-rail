import { Table } from '@/components/Table';
import { addToCart } from './services/cart';
export const CartPage = async () => Table([await addToCart('p1')]);
