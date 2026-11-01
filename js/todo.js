const KEY = 'todo.items';
const MAX_LENGTH = 200;

export function createTodoList(storage, newId = () => crypto.randomUUID()) {
  const load = () => {
    const items = storage.get(KEY, []);
    if (!Array.isArray(items)) return [];
    return items.filter((item) => typeof item?.id === 'string' && typeof item?.text === 'string');
  };

  return {
    items: load,
    add(text) {
      const clean = String(text ?? '').trim().slice(0, MAX_LENGTH);
      if (!clean) return false;
      return storage.set(KEY, [...load(), { id: newId(), text: clean, done: false }]);
    },
    toggle(id) {
      storage.set(KEY, load().map((item) => (item.id === id ? { ...item, done: !item.done } : item)));
    },
    remove(id) {
      storage.set(KEY, load().filter((item) => item.id !== id));
    },
  };
}
