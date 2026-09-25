// The theme switch (FR-6.6, D-18).
//
// Almost nothing here is new: every page's `<head>` already reads
// `lisecki-theme` and puts `light-mode` or `dark-mode` on <html> before first
// paint, and mondo.css already redefines every token under both. What was
// missing was a way to SET it from inside Mondo — the key was written only by
// lisecki.dev/theme.js, which D-18 deliberately does not load.
//
// So a choice made here is the choice for the whole domain, not just for Mondo.
// That is FR-6.6's "one theme across the domain" and not an accident.
//
// Two states, not three. Before the first click there is no stored choice and
// the system setting rules, which is the right default; after it there is one,
// and it wins everywhere. Getting back to "follow the system" means clearing
// site data — the price of a switch that is one button instead of a cycle
// through a state most people never want.
//
// Mounted by importing this module: it is page chrome, like the inline script
// it completes, and threading a button through each page's entry module would
// be five call sites to keep in step for no gain.

const KEY = "lisecki-theme";
const root = document.documentElement;

/**
 * What the page is showing right now — the explicit choice if there is one, and
 * otherwise what the system is giving us. Read off the DOM rather than off
 * storage, because the inline script is what actually decided it and a private
 * window can have thrown on the way.
 */
function current() {
  if (root.classList.contains("light-mode")) return "light";
  if (root.classList.contains("dark-mode")) return "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(theme) {
  root.classList.toggle("light-mode", theme === "light");
  root.classList.toggle("dark-mode", theme === "dark");
  // The page has already changed by here. Storage is how the choice SURVIVES,
  // so losing it in a private window costs the memory and not the click.
  try { localStorage.setItem(KEY, theme); } catch { /* ignore */ }
}

function mount(button) {
  if (!button) return;
  const draw = () => {
    const dark = current() === "dark";
    // Which icon shows is CSS's business, off this one class. Deliberately NOT
    // `svg.hidden`: `hidden` lives on HTMLElement and an <svg> is not one, so
    // assigning it sets a dead JavaScript property that reflects to no
    // attribute and matches no selector. The icons would simply never swap.
    //
    // The icon shown is the theme you would switch TO, which is the convention
    // and still ambiguous at a glance — hence the label saying it in words
    // rather than leaving a screen reader to interpret a picture of a moon.
    button.classList.toggle("is-dark", dark);
    const label = dark ? "Mudar para o tema claro" : "Mudar para o tema escuro";
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(dark));
    button.title = label;
  };
  draw();
  button.addEventListener("click", () => { apply(current() === "dark" ? "light" : "dark"); draw(); });

  // Someone on "follow the system" gets the icon corrected when the system
  // flips at sunset. Once there is an explicit choice the classes win and
  // `current()` stops caring, so this goes quiet by itself.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
}

mount(document.getElementById("theme-btn"));
