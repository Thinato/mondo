// A select box that takes several answers (FR-12.10): a native <details> over a
// list of checkboxes, so the keyboard, the focus ring and the screen reader all
// come from the browser. At least one box stays ticked — the last one cannot be
// cleared, which is the rule Treinar's continent chips have too (FR-9.9).

let open = null; // the one box that is open; a click anywhere else closes it

document.addEventListener("click", (e) => { if (open && !open.contains(e.target)) open.open = false; });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !open?.open) return;
  open.open = false;
  open.querySelector("summary").focus();
});

/**
 * @param {{ label: string, options: { value: string, text: string }[], summary: (values: string[]) => string,
 *           onChange: (values: string[]) => void }} o
 * @returns {{ node: HTMLDetailsElement, set: (values: string[]) => void }}
 */
export function multiSelect({ label, options, summary, onChange }) {
  const node = document.createElement("details");
  node.className = "multiselect";
  const head = document.createElement("summary");
  const list = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = label;
  list.append(legend);
  const boxes = options.map(({ value, text }) => {
    const row = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = value;
    box.addEventListener("change", () => {
      if (!boxes.some((b) => b.checked)) box.checked = true;
      draw();
      onChange(values());
    });
    row.append(box, ` ${text}`);
    list.append(row);
    return box;
  });
  node.append(head, list);
  node.addEventListener("toggle", () => { if (node.open) { if (open && open !== node) open.open = false; open = node; } });

  const values = () => boxes.filter((b) => b.checked).map((b) => b.value);
  const draw = () => { head.textContent = `${label}: ${summary(values())}`; };
  const set = (vs) => { for (const b of boxes) b.checked = vs.includes(b.value); draw(); };
  return { node, set };
}
