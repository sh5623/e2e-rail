import { test, expect } from '@playwright/test';

test.describe('group', () => {
  test('b runs', () => {
    expect(1).toBe(1);
  });
});
