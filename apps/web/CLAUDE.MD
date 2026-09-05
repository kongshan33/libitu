# Web App Agent Notes

Read the root `CLAUDE.MD` before editing this app.

## Stack

- Next.js 15
- React 19
- TypeScript strict
- ESLint flat config
- Shared workspace packages: `@libitu/types`, `@libitu/core`, `@libitu/ui`

## Structure

```text
app/                 Next.js routes and app shell
features/stage-one/  Current Stage 1 prototype feature
```

Route files should stay thin. Put real product UI under `features/<feature-name>`.

## Rules

- Use Server Components by default; use `"use client"` only for interactive components.
- Keep mock/demo data outside components.
- Use `next/link` for internal navigation.
- Use shared product types from `@libitu/types`.
- Use pure shared helpers from `@libitu/core`.
- Import shared design tokens from `@libitu/ui/tokens.css`.
- Do not assume React Query is installed.
