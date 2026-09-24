# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** LLM Poker Arena
**Generated:** 2026-09-24 15:10:21
**Category:** Fintech/Crypto
**Design Dials:** Variance 6/10 (Balanced / Modern) | Motion 4/10 (Standard) | Density 7/10 (Standard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Primary | `#F59E0B` | `--color-primary` |
| On Primary | `#0F172A` | `--color-on-primary` |
| Secondary | `#FBBF24` | `--color-secondary` |
| On Secondary | `#0F172A` | `--color-on-secondary` |
| Accent/CTA | `#8B5CF6` | `--color-accent` |
| On Accent/CTA | `#000000` | `--color-on-accent` |
| Background | `#0F172A` | `--color-background` |
| Foreground | `#F8FAFC` | `--color-foreground` |
| Card | `#222735` | `--color-card` |
| Card Foreground | `#F8FAFC` | `--color-card-foreground` |
| Muted | `#272F42` | `--color-muted` |
| Muted Foreground | `#94A3B8` | `--color-muted-foreground` |
| Border | `#334155` | `--color-border` |
| Destructive | `#EF4444` | `--color-destructive` |
| On Destructive | `#000000` | `--color-on-destructive` |
| Ring | `#F59E0B` | `--color-ring` |

**Color Notes:** Gold trust + purple tech

### Typography

- **Heading Font:** Orbitron
- **Body Font:** JetBrains Mono
- **Mood:** cyberpunk, neon, glitch, hud, sci-fi, dark, matrix green, magenta, chamfered, tactical
- **Google Fonts:** [Orbitron + JetBrains Mono](https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Orbitron:wght@700;900&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Orbitron:wght@700;900&display=swap');
```

### Spacing Variables

*Density: 7/10 — Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #8B5CF6;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #F59E0B;
  border: 2px solid #F59E0B;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #0F172A;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #F59E0B;
  outline: none;
  box-shadow: 0 0 0 3px #F59E0B20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Page Pattern

**Pattern Name:** Trust & Authority + Conversion

- **Conversion Strategy:** Security badges. Case studies. Transparent pricing. Low-friction form. Provide pause/stop and stop the logo carousel on focus, hover, and reduced motion. Previous/next controls provide the keyboard equivalent; pause offscreen/hidden and render a static logo set under reduced motion.
- **CTA Placement:** Contact Sales / Get Quote (primary) + Nav
- **Section Order:** Hero (mission/credibility) > Proof (logos, certs, stats) > Solution overview > Clear CTA path

---

## Motion

**Stagger List** (Standard) — Trigger: load or scroll | Duration: 300-450ms | Easing: `back.out(1.4)`

```js
gsap.from('.grid-item', { opacity: 0, scale: 0.92, y: 16, duration: 0.4, stagger: { each: 0.06, from: 'start', grid: 'auto' }, ease: 'back.out(1.4)' });
```

**Framework notes:** grid: 'auto' lets GSAP infer rows/columns from a CSS grid layout for a natural wave stagger; Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Combine with from: 'center' for a bento-grid layout to draw the eye inward first
- ❌ Don't use back.out on dense data tables; the overshoot reads as sloppy on informational UI
- ⚡ Group DOM writes; avoid interleaving layout reads (getBoundingClientRect) between staggered tweens

---

## Anti-Patterns (Do NOT Use)

- ❌ Playful design
- ❌ Unclear fees
- ❌ AI purple/pink gradients

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile

---

## Implementation notes (monitor site)

This section is maintained by hand. The generated rules above stay the source of
truth; where the implementation deliberately differs, the reason is recorded
here so the file remains trustworthy.

### Token mapping

The generator emits `--color-*` names. The monitor already had a three-tier
token layer, so the palette was bound to the existing semantic names rather than
introducing a second naming scheme:

| Generated | Monitor token | Value |
|---|---|---|
| `--color-primary` | `--accent` (brand, links, focus) | `#F59E0B` gold |
| `--color-secondary` | `--accent-text` | `#FBBF24` |
| `--color-background` | `--bg` | `#0F172A` |
| `--color-card` | `--panel` | `#222735` |
| `--color-muted` | `--panel-3` and the row-hover tint | `#272F42` |
| `--color-muted-foreground` | `--muted` | `#94A3B8` |
| `--color-foreground` | `--text` | `#F8FAFC` |
| `--color-border` | `--border` | `#334155` |
| `--color-accent` | `--cta` | `#8B5CF6` violet |
| `--color-ring` | focus outline | `#F59E0B` |

### Deliberate deviations

1. **The accent violet is the CTA fill only.** `#8B5CF6` measures **3.52:1** on
   the card surface, so it cannot carry text. It is bound to `--cta` and used
   only as the primary action background (black on violet = 4.96:1). This is
   also what the landing pattern prescribes: "accent for CTA only".
2. **Destructive text uses `#F87171`, not `#EF4444`.** `#EF4444` is **3.96:1**
   on the card surface and fails the skill's own priority-1 contrast rule as
   text. It is retained as the destructive fill (black on it = 5.58:1).
3. **Body copy stays on the system sans, not JetBrains Mono.** The generated
   pairing names JetBrains Mono as the body font, but monospaced prose at 14px is
   materially harder to read across the long explanatory passages on /docs and
   /about. JetBrains Mono carries hashes, addresses, code and tabular data,
   which is where a mono face earns its place.
4. **Typefaces are self-hosted, not CDN-linked.** The generated CSS import points
   at fonts.googleapis.com. This project makes no third-party request at runtime,
   so the latin/latin-ext subsets are vendored into
   `packages/monitor/public/assets/fonts/` with the OFL text in `NOTICE.md`. A
   typical page view fetches ~43 kB. Orbitron is restricted to `h1`, the
   wordmark, `.stat-value` and the kicker label; panel headings stay on the
   system sans, which is far more legible at the 13-14px they run at.
5. **Motion is CSS, not GSAP.** The Standard tier's stagger is a keyframe plus
   per-child delays, so the page keeps its zero-dependency guarantee. The
   animation's base state is the finished state, so suppressing it (reduced
   motion) leaves content visible rather than hidden.
6. **Radii were sharpened** to 4/8/12px to match the Minimalism/Swiss direction,
   from the 6/10/14px the sheet carried before.

### Verified

All 7 routes axe-CLEAN at WCAG 2.0/2.1/2.2 A+AA, and 56/56 browser gate runs
pass (target size, overflow, keyboard, reduced motion, RTL, states, interactive,
responsive) at the density and type scale above.
