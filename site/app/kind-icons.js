/** Each kind's glyph, shared by Treinar's cards and the Multijogador builder so a
 *  kind looks the same wherever it is picked: inline stroke paths on a 24-unit
 *  box, static markup and never data. A kind without one gets the target the tab
 *  bar uses for Treinar. */
export const ICONS = {
  shape: '<path d="M6 5.5c2-1.6 4.6-.6 6.4-1.4 2-.9 4.4.2 5 2.4.5 1.8-.7 3-.3 4.8.4 1.9 2.3 3.3 1.3 5.4-1 2-3.6 1.6-5.3 2.8-1.6 1.1-2.4 3-4.6 2.4-2-.6-1.8-2.9-3.2-4.2-1.4-1.3-3.6-1.8-3.6-4 0-2.4 2.6-3 3.2-5.1.3-1.2.1-2.4 1.1-3.1z"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4.5c3-1.6 5.5 1.6 8.5 0s4.5-.8 5.5 0v8c-1-.8-2.5-1.6-5.5 0s-5.5-1.6-8.5 0"/>',
  capital: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><path d="M10.2 9.8l1.8-2.4 1.8 2.4-1.8 1.4z"/>',
  gdp: '<path d="M4 20h16"/><path d="M7 20v-6M12 20V8M17 20v-9"/><path d="M5 9l5-4 4 3 5-4"/>',
  flagPick: '<rect x="3.5" y="5" width="7" height="5" rx="1"/><rect x="13.5" y="5" width="7" height="5" rx="1"/><rect x="3.5" y="14" width="7" height="5" rx="1"/><rect x="13.5" y="14" width="7" height="5" rx="1"/><path d="M15.5 16.8l1.3 1.2 2.2-2.6"/>',
  shapePick: '<path d="M4.5 5.5c1.4-1 2.8.2 4-.4 1.2-.5 2.3.6 1.8 2-.4 1.2.4 2-.6 2.8-1 .8-2.4 0-3.4.6-1.2.6-2.6-.4-2.4-1.8.2-1.2-.6-2.4.6-3.2z"/><path d="M15 4.8c1.6-.4 3.6.2 4 1.8.4 1.4-.6 3-2.2 3.2-1.4.2-3.2-.2-3.4-1.8-.2-1.2.4-2.9 1.6-3.2z"/><path d="M5.6 14.6c1.8-.6 3.8 0 4 1.8.2 1.6-.8 3-2.6 3-1.6 0-3-.8-3-2.4 0-1 .6-2 1.6-2.4z"/><path d="M15.5 16.8l1.3 1.2 2.2-2.6"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20.5c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"/>',
  potato: '<circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.8" ry="8.5"/><path d="M3.8 9.3h16.4M3.8 14.7h16.4"/>',
  default: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.2"/>',
};
