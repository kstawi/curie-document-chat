import { expect, it } from 'vitest';
import { closeWindow, MAX_WINDOWS, openWindow } from '../src/windows';

it('opens documents up to four, once each, and closes them', () => {
  let open: string[] = [];
  for (const id of ['a', 'b', 'c', 'd']) {
    const next = openWindow(open, id);
    expect(next.result).toBe('opened');
    open = next.open;
  }
  expect(open).toEqual(['a', 'b', 'c', 'd']);
  expect(MAX_WINDOWS).toBe(4);

  expect(openWindow(open, 'b')).toEqual({ open, result: 'already-open' });
  expect(openWindow(open, 'e')).toEqual({ open, result: 'full' });

  open = closeWindow(open, 'b');
  expect(open).toEqual(['a', 'c', 'd']);
  expect(openWindow(open, 'e')).toEqual({ open: ['a', 'c', 'd', 'e'], result: 'opened' });
  expect(closeWindow(open, 'x')).toEqual(open);
});
