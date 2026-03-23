import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZanzoService, CanUsePipe, ZanzoIfDirective } from '@zanzojs/angular';
import { WorkspaceService } from '../workspace.service';
import { schema } from '../../zanzo.config';

@Component({
  selector: 'app-permissions-showcase',
  standalone: true,
  imports: [CommonModule, CanUsePipe, ZanzoIfDirective],
  template: `
    <div class="container flex-column">
      <header class="page-header">
        <h1 class="page-title">Integration Showcase</h1>
        <p class="page-desc">
          Explore professional patterns for consuming Zanzo's reactive permissions.
          Use the global Workspace selector in the header to see instant DOM updates.
        </p>
      </header>

      <div class="feature-grid">
        <!-- Feature 1: Pipe -->
        <div class="card-base feature-card">
          <div class="feature-label">Template Utility</div>
          <h3 class="feature-title">Reactive Pipe</h3>
          <p class="feature-text">Bind permissions directly to properties. The <code>canUse</code> pipe is signal-powered and updates DOM state instantly.</p>
          
          <div class="demo-box">
             <button [disabled]="!($any('update') | canUse:$any('Module:' + workspace.activeWorkspace() + '_ventas'))()" class="w-full">
               {{ ($any('update') | canUse:$any('Module:' + workspace.activeWorkspace() + '_ventas'))() ? 'Editable (' + workspace.activeWorkspace() + ')' : 'View Only (' + workspace.activeWorkspace() + ')' }}
             </button>
             <div class="code-snippet"><code>'update' | canUse:'Module:{{ workspace.activeWorkspace() }}_ventas'</code></div>
          </div>
        </div>

        <!-- Feature 2: Directive -->
        <div class="card-base feature-card">
          <div class="feature-label">Structural Utility</div>
          <h3 class="feature-title">*zanzoIf Directive</h3>
          <p class="feature-text">Conditionally render fragments with support for <code>else</code> blocks. Zero boilerplate for guarded UI sections.</p>
          
          <div class="demo-box">
            <div *zanzoIf="$any({ action: 'update', resource: 'Module:' + workspace.activeWorkspace() + '_ventas' }); else restricted" class="access-alert success">
              Full editorial access granted in {{ workspace.activeWorkspace() }}.
            </div>
            <ng-template #restricted>
              <div class="access-alert error">Read-only mode constrained in {{ workspace.activeWorkspace() }}.</div>
            </ng-template>
            <div class="code-snippet"><code>*zanzoIf="{{ '{ action: \\'update\\', resource: \\'Module:' + workspace.activeWorkspace() + '_ventas\\' }' }}"</code></div>
          </div>
        </div>

        <!-- Feature 3: Service -->
        <div class="card-base feature-card">
          <div class="feature-label">Business Logic</div>
          <h3 class="feature-title">Programmatic API</h3>
          <p class="feature-text">Access permissions in TypeScript via <code>ZanzoService</code>. Ideal for complex guards and interactive flows.</p>
          
          <div class="demo-box">
            <div class="logic-monitor">
              <div class="logic-row">
                <span>Ventas (Editor) in {{ workspace.activeWorkspace() }}:</span>
                <span class="logic-status" [class.true]="zanzo.can('update', $any('Module:' + workspace.activeWorkspace() + '_ventas'))()">
                  {{ zanzo.can('update', $any('Module:' + workspace.activeWorkspace() + '_ventas'))() }}
                </span>
              </div>
              <div class="logic-row">
                <span>Global CSV Export:</span>
                <span class="logic-status" [class.true]="zanzo.can('use', 'Capability:export_csv')()">
                  {{ zanzo.can('use', 'Capability:export_csv')() }}
                </span>
              </div>
            </div>
            <div class="code-snippet"><code>this.zanzo.can('update', '...')</code></div>
          </div>
        </div>
      </div>
    </div>

    <style>
      .page-header { margin-bottom: 2rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 1.5rem; }
      .page-title { font-size: 1.50rem; }
      .page-desc { color: var(--text-dim); font-size: 0.875rem; }

      .form-select {
        background: var(--bg-card); border: 1px solid var(--border-subtle); color: var(--text-main);
        padding: 6px 10px; border-radius: 6px; font-family: inherit; font-size: 0.85rem;
      }

      .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; }
      .feature-card { padding: 1.5rem; display: flex; flex-direction: column; }
      
      .feature-label { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; color: var(--accent); margin-bottom: 0.5rem; letter-spacing: 0.05em; }
      .feature-title { font-size: 1.1rem; margin-bottom: 1rem; }
      .feature-text { font-size: 0.85rem; color: var(--text-dim); line-height: 1.6; flex-grow: 1; margin-bottom: 1.5rem; }

      .demo-box { display: flex; flex-direction: column; gap: 0.75rem; background: rgba(0,0,0,0.1); padding: 1rem; border-radius: 6px; }
      .w-full { width: 100%; }

      .access-alert { padding: 8px 12px; border-radius: 4px; font-size: 0.8rem; font-weight: 600; border: 1px solid transparent; }
      .access-alert.success { background: rgba(0, 255, 150, 0.05); color: var(--success); border-color: rgba(0, 255, 150, 0.1); }
      .access-alert.error { background: rgba(255, 50, 50, 0.05); color: var(--error); border-color: rgba(255, 50, 50, 0.1); }

      .logic-monitor { display: flex; flex-direction: column; gap: 4px; }
      .logic-row { display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-dim); }
      .logic-status { font-weight: 700; color: var(--error); text-transform: uppercase; font-size: 0.7rem; }
      .logic-status.true { color: var(--success); }

      .code-snippet { font-size: 0.65rem; padding-top: 0.5rem; border-top: 1px solid var(--border-subtle); opacity: 0.6; }
    </style>
  `
})
export class PermissionsShowcaseComponent {
  public zanzo = inject<ZanzoService<typeof schema>>(ZanzoService);
  public workspace = inject(WorkspaceService);
}
