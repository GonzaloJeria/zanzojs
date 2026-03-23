# Zanzo Angular E2E Test Application

This application is designed to functionally test the `@zanzojs/angular` adapter end-to-end to ensure reactivity with Angular 19 Signals without the need of `TestBed` or mocking. 

## How to run

1. Go to root dir and build core:
   ```bash
   pnpm run build
   ```

2. Run the test app:
   ```bash
   pnpm --filter angular-test dev
   ```

## Acceptance Criteria Checklist

### Flow 1: Admin
1. Click **Hydrate as Admin**
2. Ensure everything in the table reads `true` except `stock` `edit` and `delete`.
3. Check **Showcase**: All buttons should be enabled. The directive should say "Puedes editar ventas".
4. Navigate to `/dashboard`, `/edit`, and `/export`. The routes should be accessible.

### Flow 2: Viewer
1. Click **Hydrate as Viewer**
2. Ensure the table updates dynamically: `edit`, `delete` actions and export `use` should become `false`.
3. Check **Showcase**: The buttons should be disabled. The directive should show the fallback "No tienes permiso de edición".
4. Navigate to `/edit` or `/export`. It should redirect to `/unauthorized`. `/dashboard` is still accessible.

### Flow 3: Clear
1. Click **Clear**
2. The entire table must flip to false.
3. Every protected route will redirect to `/unauthorized`.
