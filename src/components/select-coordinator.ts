let active: { id: string; close: () => void } | undefined;

export function activateSelect(id: string, close: () => void) {
  if (active?.id !== id) active?.close();
  active = { id, close };
}

export function deactivateSelect(id: string) {
  if (active?.id === id) active = undefined;
}

export function closeActiveSelect() {
  const current = active;
  active = undefined;
  current?.close();
}
