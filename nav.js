// Main navigation dropdowns (SEO Tools, SEO Studies).
// The shared name="main-nav" attribute on the <details> elements already keeps
// only one menu open at a time. This script also closes an open menu when the
// visitor clicks or taps elsewhere, presses Escape, or tabs out of it.
(() => {
  const menus = [...document.querySelectorAll('details.nav-dropdown')];
  if (!menus.length) return;

  const closeMenusOutside = target => {
    menus.forEach(menu => {
      if (menu.open && !menu.contains(target)) menu.open = false;
    });
  };

  // pointerdown (not click) so taps on non-interactive areas also close the menu on iOS Safari.
  document.addEventListener('pointerdown', event => closeMenusOutside(event.target));

  // Keyboard users: moving focus to anything outside a menu closes it.
  document.addEventListener('focusin', event => closeMenusOutside(event.target));

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    menus.forEach(menu => {
      if (!menu.open) return;
      const hadFocus = menu.contains(document.activeElement);
      menu.open = false;
      if (hadFocus) menu.querySelector('summary')?.focus();
    });
  });
})();
