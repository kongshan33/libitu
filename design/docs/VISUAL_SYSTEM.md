# Web visual system

## Typography

The user approved loading Inter on 2026-10-04. The root layout loads the locally bundled Inter 4.1 normal and italic variable fonts with `next/font/local`, `display: swap` and an adjusted Arial fallback. The `--font-ui` token selects this family across headers, body text and controls. Fonts and their OFL license live in `apps/web/app/fonts`; there are no remote font requests at runtime or build time. Unsupported glyphs fall back to system fonts. Existing monospace pronunciation/structure/code text keeps its own stack.

Existing grids, ordering, spacing, control dimensions and responsive breakpoints remain. Font metrics can change text wrapping; check narrow viewports after typography changes. The shared landing wordmark keeps its proportions, purple color and dot.

## Fields

Use `Input`, `Textarea` and `NativeSelect` from `apps/web/components/ui/field.tsx`. Existing Radix Select triggers share the same field appearance. Feature CSS still owns dimensions, padding, line height and resize behavior. `field.css` owns white surfaces, warm borders, placeholder color, purple focus, invalid red borders, disabled states and reduced motion.

Inputs inside a search/video wrapper use `appearance="bare"`. Put `className="ui-field-surface"` and `data-field-surface` on the existing wrapper, preserving its existing feature class. Focus and invalid/disabled appearance then belong to the wrapper. Chat keeps its existing pill shape with `shape="pill"`. Keep native form semantics, labels, aria descriptions and handlers. Checkboxes, radios and file controls remain native; their purple accent and common disabled/focus feedback come from global tokens.

## Selection and learning colors

`--selection-background`, `--selection-text` and `--selection-border` define purple selected chips, segments and cards. Underline tabs retain their underline presentation. `aria-pressed`, `aria-selected` and the existing check marks communicate selection beyond color. Corpus kinds, success/warning and Sound/Rhythm/Melody teaching colors remain separate semantic roles; never apply generic purple selection styling indiscriminately to them.

## Actions

Follow [the button system](BUTTON_SYSTEM.md). Shared components own action paint; feature classes retain geometry. This follow-up removes 135 redundant appearance declarations from 50 rules used exclusively by shared buttons. Rules also used by native learning or selection controls remain where they are needed.

Auxiliary corpus deletion/sync, assessment retries, recording setup/finalization, saved-take playback/deletion/pagination and reference-analysis controls now show pending feedback. Only the action being performed shows progress; other conflicting actions remain disabled. Cancellable listening/preparation and continuous media states retain their existing explicit status and cancellation controls. Idle button content reserves the loading footprint.

## Verification

Verified 2026-10-04: root lint, production build and 1,185 tests pass (761 API, 306 web, 118 extension; unchanged tasks may use the build cache). All nine screens pass at 1440 and 390 px, with actual locally served Inter rendering and no horizontal page overflow. Inspected desktop/mobile screenshots include form error/edit/focus and the speaking composer.

`apps/web/tests/visual-system.browser.mjs` covers the nine principal web screens at desktop/mobile widths, verifies actual custom Inter glyph rendering through Chrome's font inspection, checks locally served font requests and horizontal overflow, and exercises field validation, search, editing and native selects. `buttons.browser.mjs` covers primary/destructive/recording states, focus, loading geometry, repeat-click prevention and reduced motion. Browser identity, API responses and microphone input are fixtures, not real provider acceptance.

Run root `pnpm lint`, `pnpm build` and `pnpm test`. Font or shared-style changes also require desktop/mobile visual inspection. Provider authentication and live microphone/service integration remain separate product checks.

## Page canvas

Reader footer follow-up (2026-10-04): the Stage 2 entry bar spans the viewport horizontally, canceling the reader gutter only for this footer. Its content keeps internal padding; other reader sections retain their responsive gutters.

Page backgrounds and outer gutters use the white primary background. Keep warm-neutral secondary backgrounds for inner surfaces only; do not change the secondary token to recolor page canvases. Existing spacing and framing remain unchanged.

## Application header

`AppHeader` owns global navigation, Logo size, 32/20/16 px horizontal gutters and account actions on library, profile and mission pages. At 900 px and below, navigation occupies a second row; current-section links use purple selection colors. Mission-specific controls remain within the content.

## Select and directional controls

Use `SelectField` for controlled option lists and the Radix primitives for custom compositions. Empty values are encoded internally so All sources remains a selectable choice. Trigger arrows have 16 px horizontal inset; options have background highlights without borders or outlines, with a light 1 px menu edge and soft shadow. Native visible selects are no longer used.

Use `DirectionButton` and `DirectionLink` for back/next navigation: 40 px minimum height, 16 px icons and 8 px gaps. Retain multiline card dimensions. Reader bottom padding is zero, with shell height accounting only for the top gutter.

Loadout follow-up: draft-save status keeps its layout footprint when hidden, with delayed visual feedback for normal-motion users. Textarea focus uses a thin neutral outline and retains its normal border color. Directional links default to secondary outlined styling. Existing navigation wording is unchanged.
