import { Component } from '@angular/core';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  template: `
    <div class="container flex-column">
      <header class="page-header">
        <h1 class="page-title">Executive Dashboard</h1>
        <p class="page-desc">System-wide overview of current operations and reactive metrics.</p>
      </header>

      <div class="card-base" style="padding: 2rem; border-left: 4px solid var(--success);">
        <h3 style="margin-bottom: 0.5rem; color: var(--success);">Session Validated</h3>
        <p style="color: var(--text-dim); font-size: 0.875rem;">
          The engine has successfully verified your credentials. Access granted via Router Guard.
        </p>
      </div>
    </div>
  `
})
export class DashboardComponent {}

@Component({
  selector: 'app-edit',
  standalone: true,
  template: `
    <div class="container flex-column">
      <header class="page-header">
        <h1 class="page-title">Resource Editor</h1>
        <p class="page-desc">Modify and persist system entities with live authorization guards.</p>
      </header>

      <div class="card-base" style="padding: 2rem; border-left: 4px solid var(--accent);">
        <h3 style="margin-bottom: 0.5rem; color: var(--accent);">Write Access Active</h3>
        <p style="color: var(--text-dim); font-size: 0.875rem;">
          Relationship resolved: You are authorized to access this protected route.
        </p>
      </div>
    </div>
  `
})
export class EditComponent {}

@Component({
  selector: 'app-export',
  standalone: true,
  template: `
    <div class="container flex-column">
      <header class="page-header">
        <h1 class="page-title">Export Services</h1>
        <p class="page-desc">Extract system data into portable formats via authorized capabilities.</p>
      </header>

      <div class="card-base" style="padding: 2rem; border-left: 4px solid var(--accent);">
        <h3 style="margin-bottom: 0.5rem; color: var(--accent);">Capability Found</h3>
        <p style="color: var(--text-dim); font-size: 0.875rem;">
          You are permitted to <code>use</code> the global <code>Capability:export_csv</code> feature.
        </p>
      </div>
    </div>
  `
})
export class ExportComponent {}

@Component({
  selector: 'app-unauthorized',
  standalone: true,
  template: `
    <div class="container flex-column" style="align-items: center; justify-content: center; height: 60vh; text-align: center;">
      <h1 style="font-size: 4rem; color: var(--error); margin-bottom: 1rem;">403</h1>
      <h2 style="margin-bottom: 0.5rem;">Access Restricted</h2>
      <p style="color: var(--text-dim); max-width: 400px;">
        The Zanzo engine could not resolve a valid relationship for your current identity.
      </p>
      <button routerLink="/" class="btn-primary" style="margin-top: 2rem;">Return to Control Center</button>
    </div>
  `
})
export class UnauthorizedComponent {}
