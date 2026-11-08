# Design system — Nova overlay

<!-- impeccable:design-schema 1 -->

## Visual world

Deep space cinematic × Factory Records catalog. Near-black ground, one committed pulsar-purple accent, aurora cyan as the navigation color, and Nova's alien avatar as the only organic warmth. Everything else is intentional void.

## Color

```
--void:        #07080f   deepest background, void
--space:       #0d0f1c   card background
--space-800:   #131629   raised surfaces, Nova message bubbles
--space-700:   #1a1f38   hover states
--space-600:   #252a4d   borders, dividers
--nebula:      #7c3aed   primary action (send button, Deep Dive, selection)
--nebula-600:  #6d28d9   pressed / darker hover
--nebula-500:  #8b5cf6   waveform bars, lighter highlight
--comet:       #a78bfa   chip labels, secondary accent, web-source marker
--aurora:      #67e8f9   timestamp navigation (Watch button), caret, lecture-source marker
--pulse:       #c084fc   live status dot, antenna orbs on alien avatar
--star:        #f0e6ff   primary text (starlight white, slightly violet)
--star-soft:   rgba(240,230,255,0.72)   secondary text, bubble body
--star-muted:  rgba(240,230,255,0.42)   placeholder, metadata labels
--student-bg:  #2e1065   student message bubble background
--student-txt: #ede9fe   student message bubble text
```

Error/warn follow standard semantic colors on space grounds:
- warn: `#1c1500` bg, `#fbbf24` ink
- error: `#1a0808` bg, `#f87171` ink

## Typography

System UI stack (`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`). 14px body, 1.45 line-height.

**Title "ASK NOVA":** 17px, font-weight 300, letter-spacing 0.12em, text-transform uppercase — Factory Records engraved catalog designation.

## Spacing

4px base grid. All spacing tokens are multiples of 4.

## Avatar — Nova the alien

60px (card header) and 32px (message row). SVG alien: mint-green (#7ee8a2) oval head, purple (#c084fc) antenna orbs with white shine, large white sclera with dark pupils, eye-catch highlights at top-right, rosy blush ellipses at cheeks (rgba 192,132,252,0.45), dark smile arc. Purple radial gradient background behind the SVG. Warm blush and wide eyes give a Pixar side-character read at both sizes.

When `icons/nova.png` exists, it replaces the SVG via `--nova-mascot` CSS custom property.

## Signature interaction

**Waveform typing indicator.** Seven narrow bars (3px wide, 2px radius) at varying heights (6–20px), animated with `nova-wave` staggered: each bar scales from 0.35× to 1× vertically. Gives an oscilloscope / pulsar trace read — the Factory Records Unknown Pleasures lineage visible in Nova's "thinking" state.

**Status cascade flip.** When the status text changes (setPlayback), `nova-flip` plays: a 180ms exponential-out from y+4 at opacity 0.2 to y0 at opacity 1. The timestamp counter reads like a departures board tracking the cosmos (split-flap challenger raise).

## Component library

**Card:** `border-radius: 20px`, shadow with purple glow `0 0 60px rgba(124,58,237,0.08)` plus depth shadows. No white.

**Avatar:** Dark purple radial-gradient background, purple ring-shadow glow.

**Message bubbles:**
- Nova: `--space-800` bg, 1px `--space-600` border, `--star-soft` text.
- Student: `--student-bg` bg, 1px rgba-nebula border, `--student-txt` text.
- Source markers (ready): `.bubble--lecture` = 2px aurora left border; `.bubble--web` = 2px comet left border.

**Watch button:** Aurora cyan text, low aurora tint bg (`rgba(103,232,249,0.07)`), cyan border. SVG play icon replaces ▶ glyph.

**Deep Dive button:** Linear gradient `#7c3aed → #a855f7`, purple glow shadow. The portal to the full lesson.

**Chips:** Dark space bg, comet text, comet border at 40% opacity.

**Composer:** `--space-800` bg, `--space-600` border. Focus: nebula border + 3px nebula glow. Caret: aurora.

**Send button:** Idle = space-700 bg, muted icon. Active = nebula bg with 10px glow.

**Launcher (minimized):** Purple radial gradient orb, animated glow + gentle float (`nova-float` 4s infinite).

**Menu / popover:** `#131629` bg, nebula-tinted border and shadow, comet-colored icons.

## Motion

- `nova-in` (card entrance): 180ms ease-out from y+12 at 0.98 scale
- `nova-pop` (menu, popover): 120–140ms ease-out from 0.9 scale
- `nova-wave` (typing waveform): 1.1s ease-in-out infinite, staggered per bar
- `nova-flip` (status update): 180ms cubic-bezier(0.22,1,0.36,1) — exponential out
- `nova-glow` (live dot pulse): 2.4s ease-in-out infinite, shadow breathing
- `nova-float` (launcher bob): 4s ease-in-out infinite, 4px vertical travel
- `nova-spin` (progress spinner): 0.8s linear infinite

All disabled with `prefers-reduced-motion: reduce`.

## Accessibility

WCAG AA minimum. All foreground/background combinations confirmed ≥4.5:1. Focus rings: aurora on icon-btn/launcher, comet on chips/send/menu-items. ARIA labels on all interactive elements. Keyboard-navigable throughout.
