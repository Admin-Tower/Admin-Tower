# Admin-Tower
Control Tower for System Administration.

## UI styling

The `tower-ui` Angular app uses Angular Material and Tailwind CSS.

- Import Material components from `@angular/material/<component>` into standalone
  components as needed. Customize the Material theme in
  `apps/web/tower-ui/src/styles.scss`.
- Use Tailwind utility classes directly in templates. Tailwind is processed by
  PostCSS through `apps/web/tower-ui/src/tailwind.css`, separately from SCSS.
  Source detection is scoped to the app's `src` directory; add `@source` paths in
  that file when introducing shared UI libraries.

Run `pnpm nx serve tower-ui` for development or `pnpm nx build tower-ui` for a
production build.
