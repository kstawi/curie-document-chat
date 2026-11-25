// Which documents are open as windows, in the order they were opened.
export const MAX_WINDOWS = 4;

export type Opened = 'opened' | 'already-open' | 'full';

export function openWindow(open: string[], id: string): { open: string[]; result: Opened } {
  if (open.includes(id)) return { open, result: 'already-open' };
  if (open.length >= MAX_WINDOWS) return { open, result: 'full' };
  return { open: [...open, id], result: 'opened' };
}

export const closeWindow = (open: string[], id: string) => open.filter((o) => o !== id);
