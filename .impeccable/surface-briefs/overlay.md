# Surface brief: Nova overlay panel

**Target:** extension/overlay.css + extension/overlay.js
**Mode:** Operate
**Visitor job:** Ask questions about the current lecture while watching it, navigate to timestamps, trigger a deep lesson.

---

## Direction contract

THESIS: A cinematic deep-space observation terminal where every pixel of negative space is intentional. Refuses the light-card-on-white chat widget category default and the generic "dark mode with purple accent" cluster. The look arrives from two incompatible ancestors fused into one surface: a Factory Records catalog sleeve (FAC designation, matte black, white hairline pulsar plot) and a deep-space astronomical record (nebula color, starfield ground, glowing phenomena).

OWN-WORLD: Ground is #0a0b16 to #0d0f1c — not generic dark, specifically the color of a CCD sensor cooling to operating temperature. Primary text is #f0e6ff, a starlight white with just enough violet to belong. Two committed accent roles: nebula purple (#7c3aed / #a78bfa) for primary action and selection, aurora cyan (#67e8f9) for timestamp/location navigation — the two most recognizable colors in a Hubble image. Nova's avatar is a mint-green alien with big dark eyes, light-catch highlights, purple antenna orbs, and rosy cheek blush — the only warm thing in the terminal. The catalog discipline shows in one place: the title "ASK NOVA" in light-weight widely-tracked uppercase — a FAC designation on the terminal door.

STORY: The student opens the panel and immediately knows they are in something purpose-built, not a floating web widget. Nova's alien face signals it is safe to ask anything. They type or tap a chip. Nova thinks — the waveform typing indicator pulses like an oscilloscope. The answer arrives with a Watch timestamp (aurora cyan, navigates by light-speed to that moment) and a Deep Dive button (nebula gradient, the portal to a full lesson). Every text update in the status bar cascades with a brief flip — the terminal is live, tracking the cosmos.

FIRST VIEWPORT: 560px card, bottom-left anchor. Header: dark starfield ground, nebula glow at left, aurora glow at top-right. Alien avatar 60px, right side glowing purple ring. Title "ASK NOVA" in light tracked uppercase, below it the cascade status line. Messages fill the remaining space; Nova bubbles on the left with the small alien avatar (32px), student bubbles deep-purple right. Five-bar waveform typing indicator replaces the dot trio. Bottom: horizontal chip strip then the composer input. Footer: single muted disclaimer line. Launcher (minimized state): glowing purple orb that gently floats — the alien visible inside.

FORM: Deep space cinematic × Factory Records catalog. Assigned index 5 of the grounded list (seed run a24fcf4bc1b0fc3fa127763154375a04).
seed: 780d1ca99860a793

Raises carried in:
- Split-flap challenger: status text "Following at 7:48" briefly cascade-flips on each update — a nova-flip keyframe triggered in setPlayback()
- Crouwel challenger: 4px grid compliance; "ASK NOVA" in font-weight 300, letter-spacing 0.12em, text-transform uppercase
- Manual acetate challenger: `.bubble--lecture` and `.bubble--web` CSS classes ready for aurora/comet left-edge marking when the backend provides source metadata

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
