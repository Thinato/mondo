// A solved challenge gets a moment (D-55, FR-6.10).
//
// Thirty lines of DOM and one keyframe rather than a dependency: the whole
// effect is coloured rectangles falling with a spin, and putting a third-party
// script on the critical path of a page that loads no bundler to draw them is a
// bad trade.
//
// This is decoration and nothing else, which is why `prefers-reduced-motion`
// turns it off completely rather than slowing it down, and why the nodes are
// `aria-hidden`: there is nothing here for a screen reader, the reveal text
// beside it says what happened.

const COLORS = ["#2ea043", "#d29922", "#1f6feb", "#db6d28", "#8957e5"];
/** Long enough for the slowest piece (delay .5s + duration 2.6s) to land. */
const CLEANUP_MS = 3200;

export function confetti(count = 70) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = COLORS[i % COLORS.length];
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    p.style.animationDuration = `${1.6 + Math.random()}s`;
    p.style.setProperty("--drift", `${(Math.random() - 0.5) * 24}vw`);
    p.style.setProperty("--spin", `${360 + Math.random() * 720}deg`);
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), CLEANUP_MS);
}
