# Shared button system

Accepted 2026-10-04. Purple primary actions and learning semantic colors remain; existing page layouts and control dimensions are preserved.

## Roles

| Variant | Use | Appearance |
|---|---|---|
| `primary` | Main action in a task or dialog | Purple / white |
| `secondary` | Alternative action | White / warm thin edge |
| `soft` | Supporting action | Warm gray |
| `ghost` | Close, back and quiet tools | Transparent |
| `danger` | Entry to destructive confirmation | Red text |
| `danger-solid` | Final destructive confirmation | Red / white |
| `record` | Start voice or recording | Black / white; `recording` turns red |

## Implementation

Use `Button` and `ButtonLink` from `apps/web/components/ui/button.tsx`; use `buttonAppearance` for native external anchors. Navigation stays an anchor. Button defaults to `type="button"`; forms explicitly set `type="submit"`.

Shared paint and interaction rules live in `button.css`; semantic colors use `packages/ui/src/tokens.css`. Feature styles retain geometry during migration; shared appearance attributes override their legacy paint. New actions should not add per-page color, shadow, focus or disabled rules.

The mobile stage navigation explicitly permits shrinking inside its existing horizontal scroll area so the unified weight does not widen the page.

Existing controls use `size="inherit"` to retain padding, font size, width and height. New controls use `sm`, `md` or `lg` (32/40/44 px minimum height). Ordinary radius is 8 px; media pills and circular tools use explicit `shape`. Supply an accessible name for icon-only controls.

Pass stable idle children with `loading` and `loadingLabel`. The idle content reserves space while an overlay displays progress. Loading disables native clicks and exposes `aria-busy`; it does not replace application-level idempotency. Hover, pressed, keyboard focus, disabled and reduced-motion behavior are shared. Existing learning tabs, filters, switches and selectable cards retain their own selection semantics.

```tsx
<Button variant="primary" size="inherit" className={styles.save}
  type="submit" loading={saving} loadingLabel="Saving…">
  Save changes
</Button>
<ButtonLink variant="secondary" href="/corpus">Open corpus</ButtonLink>
```

## Verification

Verified 2026-10-04: desktop (1440 px) and mobile (390 px) button regressions pass. The mobile topbar and stage navigation now permit shrinking inside their existing layout, eliminating a 2 px regression introduced by uniform button weight.

Run root `pnpm lint`, `pnpm build` and `pnpm test`. The optional `apps/web/tests/buttons.browser.mjs` regression uses Playwright with Chrome and a running local web server. Set `LIBITU_PLAYWRIGHT_MODULE` when Playwright is outside the workspace. It checks desktop/mobile submit and link semantics, focus/hover colors, stable loading geometry, repeat-click prevention, reduced motion, destructive confirmation and recording state colors. Identity and API responses are fixtures; microphone input is synthetic. These checks do not verify real authentication or provider integrations.
