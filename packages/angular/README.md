# @zanzojs/angular

[![npm version](https://img.shields.io/npm/v/@zanzojs/angular.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/angular)
[![Angular Compatible](https://img.shields.io/badge/Angular-%3E%3D19.0.0-dd0031.svg?style=flat-square)](https://angular.dev)

Angular bindings for ZanzoJS. O(1) permission checks on the frontend powered entirely by Angular Signals, with zero network requests after hydration.

## How it works

The server compiles a flat permission map (snapshot) once per user. The frontend receives it (via SSR integration or XHR), hydrates the `ZanzoService`, and evaluates every permission check as a highly-optimized, reactive Signal.

### 🚀 Edge & SSR Ready
The Angular adapter is fully compatible with Angular SSR running on the Edge (e.g., Cloudflare Workers). Use `TransferState` as documented below to seamlessly hydrate permissions from server to client without extra network roundtrips.

## Installation

```bash
pnpm add @zanzojs/core@latest @zanzojs/angular@latest
```

> **Note**: This adapter requires Angular 19+ due to its heavy reliance on the modern Signals API and standalone components.

## Step-by-Step Guide

### 1. Configure the Provider

Provide the Zanzo core configuration at the root of your application (`app.config.ts`), supplying your typed schema. If utilizing SSR, configure an optional `snapshotKey` to automatically hydrate state from the server.

```typescript
import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideZanzo } from '@zanzojs/angular';
import { schema } from './zanzo.config';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideZanzo({
      schema, // Required: Type-safe schema definition
      unauthorizedRoute: '/unauthorized', // Default fallback for Guards
      snapshotKey: 'ZANZO_SNAPSHOT' // Optional: TransferState key for SSR hydration
    })
  ]
};
```

### 2. Hydrate the Service

If you aren't using SSR automatic hydration, inject `ZanzoService` to hydrate the snapshot manually once the user authenticates.

```typescript
import { Component, inject } from '@angular/core';
import { ZanzoService } from '@zanzojs/angular';
import type { schema } from '../zanzo.config';

@Component({
  selector: 'app-login',
  standalone: true,
  template: `<button (click)="login()">Login</button>`
})
export class LoginComponent {
  // Pass your schema type for strict auto-completion
  private zanzo = inject<ZanzoService<typeof schema>>(ZanzoService);

  async login() {
    const snapshot = await fetchUserPermissions(); 
    // Hydrate the service. All Signals will instantly react across the app.
    this.zanzo.hydrate(snapshot);
  }

  logout() {
    this.zanzo.clear(); // Revokes everything instantly
  }
}
```

### 3. Check Permissions in Templates

Zanzo provides multiple utilities to check permissions seamlessly in Angular templates.

#### Using the `*zanzoIf` Directive
A structural directive that conditionally renders elements based on permissions. Supports `else` blocks just like `*ngIf`.

```html
<div *zanzoIf="{ action: 'edit', resource: 'Document:123' }; else noEdit">
  <button>Edit Document</button>
</div>

<ng-template #noEdit>
  <p>You do not have permission to edit this.</p>
</ng-template>
```

#### Using the `canUse` Pipe
A pure pipe that resolves to a reactive Angular Signal returning a boolean.

```html
<!-- Disables the button if the user is not an admin on Document:123 -->
<!-- Note: The pipe returns a Signal, so you must invoke it with () in the template -->
<button [disabled]="!('admin' | canUse:'Document:123')()">
  Delete Document
</button>
```

To use these in your Standalone Components, add them to your `imports` array:

```typescript
import { Component } from '@angular/core';
import { ZanzoIfDirective, CanUsePipe } from '@zanzojs/angular';

@Component({
  standalone: true,
  imports: [ZanzoIfDirective, CanUsePipe],
  templateUrl: './my.component.html'
})
export class MyComponent {}
```

### 4. Direct Signal Usage

For programmatic logic, `ZanzoService.can()` returns an Angular `Signal<boolean>` allowing you to reactively trigger effects or compute states.

```typescript
import { Component, inject, effect } from '@angular/core';
import { ZanzoService } from '@zanzojs/angular';
import type { schema } from '../zanzo.config';

@Component({ /* ... */ })
export class DocumentActions {
  private zanzo = inject<ZanzoService<typeof schema>>(ZanzoService);
  
  // O(1) reactive lookup
  canDelete = this.zanzo.can('delete', 'Document:123');

  constructor() {
    effect(() => {
      if (this.canDelete()) {
        console.log("User currently has delete permissions.");
      }
    });
  }
}
```

### 5. Protect Routes with `zanzoGuard`

Zanzo ships with a functional Router Guard to protect your Angular routes. It evaluates permissions synchronously.

```typescript
import { Routes } from '@angular/router';
import { zanzoGuard } from '@zanzojs/angular';

export const routes: Routes = [
  {
    path: 'admin/billing',
    component: BillingComponent,
    canActivate: [zanzoGuard('admin', 'Organization:acme')], // Route protection
    // To specify a custom redirect route for this specific guard:
    // canActivate: [zanzoGuard('admin', 'Organization:acme', '/upgrade-plan')]
  }
];
```

## Best Practices & Security

### Client-side Security Warning
> [!WARNING]
> **UX Only**: Client-side permission checks are purely for UI/UX purposes (e.g., hiding a button). Since snapshots are evaluated strictly in the browser memory, they can be manipulated by a malicious user. **Always** perform a secondary authorization check on the backend before executing any sensitive mutation or delivering protected data.

## Documentation
For backend setup and database adapters, see the [ZanzoJS Monorepo](https://github.com/GonzaloJeria/zanzo).
