import { useEffect, useRef } from "react";

export function CommandPalette({
  emptyMessage,
  open,
  onSubmitQuery,
  title,
  placeholder,
  query,
  selectedIndex,
  items,
  onQueryChange,
  onClose,
  onSelectIndex,
  onExecute
}: {
  emptyMessage?: string;
  open: boolean;
  onSubmitQuery?: () => void;
  title: string;
  placeholder: string;
  query: string;
  selectedIndex: number;
  items: Array<{ id: string; title: string; description?: string }>;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onSelectIndex: (index: number) => void;
  onExecute: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose} role="presentation">
      <div
        className="command-palette"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onSelectIndex(items.length === 0 ? 0 : Math.min(selectedIndex + 1, items.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            onSelectIndex(items.length === 0 ? 0 : Math.max(selectedIndex - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const activeItem = items[selectedIndex];
            if (activeItem) {
              onExecute(activeItem.id);
            } else {
              onSubmitQuery?.();
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="command-palette-header">{title}</div>
        <input className="command-palette-input" placeholder={placeholder} ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} />
        <div className="command-palette-results">
          {items.length === 0 ? (
            <div className="command-item empty">{emptyMessage ?? "No results."}</div>
          ) : (
            items.map((item, index) => (
              <button className={`command-item ${index === selectedIndex ? "is-active" : ""}`} key={item.id} onClick={() => onExecute(item.id)} onMouseEnter={() => onSelectIndex(index)} type="button">
                <strong>{item.title}</strong>
                {item.description ? <span>{item.description}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
