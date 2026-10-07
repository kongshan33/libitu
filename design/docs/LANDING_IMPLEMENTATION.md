# Libitu landing page

Implemented locally on 2026-10-03. The provided HTML is a visual reference only; none of its source or export styles are copied into the application.

## Experience and routing

- The root with no source identity renders the new `features/landing` server component. Shared product tokens and scoped CSS define the visual style; only the form and existing account controls need client interaction.
- Nonempty `sourceUrl`, `contentId`, `jobId` or `handoffId` retains the existing Stage 1 reader. Existing extension, content recovery and Shadow query parameters remain intact. Campaign, language, title or authentication parameters alone do not invoke the demo source.
- The form accepts standard YouTube watch links, short share links, mobile links and Shorts, including known bare host forms. It requires an 11-character video ID, rejects unrelated/spoofed hosts, credentials, duplicate video IDs, non-HTTP protocols and nonstandard ports, and bounds input to 2,048 characters.
- Navigation contains only the canonical `sourceUrl`. Tracking, externally supplied redirect fields, fabricated language and title are omitted. The existing resolve/job/blueprint lifecycle owns processing, recoverable failures and durable URL updates. An unknown title displays as “YouTube video” while loading, never the old demo title; it is omitted from content writes.
- The page makes Shadow optional, labels its phrase/conversation preview as illustrative, states English/caption limits and explains where authentication is required.

## Authentication

The landing navigation reuses `AuthControls`, the root `ClerkProvider` and existing middleware. Actual Clerk sign-in and sign-up modals use the initiating `window.location.href` as the forced return target for both authentication modes. Arbitrary redirect query parameters are not used as destinations. Existing signed-in users get My learning and the Clerk account menu.

The form stores only its bounded input in `sessionStorage` under `libitu:landing-video:v1`. This survives a reload or same-tab authentication redirect, including login/register cancellation. Storage failures leave the form functional. No account/session/token state is added, and existing guest corpus adoption and owner checks are unchanged.

## Extension and publication

Set server environment variable `LIBITU_CHROME_STORE_URL` to the verified HTTPS Chrome Web Store detail listing when one is published. The hero always shows the prototype-style centered “or” and “Add to Chrome” entry with a Chrome icon. Missing/invalid configuration points this entry to in-page installation details and explicitly labels the store release as coming soon; a configured listing opens the actual store. No listing ID is invented. No unfinished legal links are shown.

This work adds no backend endpoint, schema, paid provider, permissions or deployment. Captions still depend on the existing supported provider/browser paths; the landing page does not expand language or platform coverage.

## Verification

- Root `pnpm lint`, `pnpm build`, `pnpm test`: passed. 761 API, 306 web and 118 extension tests (1,185 total; unchanged tasks may reuse cached results).
- Six entry regressions cover source versus campaign routing, canonical links, malformed/spoofed URLs, removal of embedded title/language/redirect claims, store-link validation and the existing resolve → job → blueprint flow without fabricated metadata.
- Browser: 320/390/768/1440 px checked for horizontal overflow; desktop and mobile visual inspection, mobile single-column cards, labels, empty/invalid input, Enter submission, footer CTA focus and session-draft refresh passed.
- Real configured Clerk SDK: sign-in, sign-up, transfers in both directions and closing the modal passed. Email, Google and GitHub controls were visible. No credentials were entered, account created, or OAuth completed; authenticated menu and completed provider round trips remain separate acceptance.
- Browser with a temporary local API fixture: pasted share link reached ready Stage 1 with canonical source, real content/job query parameters and fixture title. Refresh recovered the same content and returning through the logo restored the landing page and draft. Fixture requests made no model/database writes; this does not verify live YouTube availability or provider quality.

The original prototype and other in-progress workspace features remain untouched by this increment.

2026-10-03 entry refinement: Stage 1 remains anonymous; the form now explicitly says “No sign-in required.” The Chrome entry is a separate 48px-high centered button under an “or” divider on desktop and mobile, matching the visual prototype. Its unconfigured state leads to installation details, not an invented store URL.
