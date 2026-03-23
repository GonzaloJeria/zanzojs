import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ZanzoService } from '@zanzojs/angular';
import { WorkspaceService } from '../workspace.service';
import { adminSnapshot, viewerSnapshot } from '../../mock-snapshots';
import { schema, testExtension } from '../../zanzo.config';

@Component({
  selector: 'app-hydration',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="container flex-column">
      <header class="page-header">
        <h1 class="page-title">Control Center</h1>
        <p class="page-desc">Hydrate the Zanzo engine with signed snapshots and select the active workspace.</p>
      </header>

      <div class="grid-cols">
        <!-- Identity & Workspace Selection Section -->
        <section class="card-base section-box">
          <div class="section-header">
            <h3 class="section-title">Context selection</h3>
            <span class="badge" [class.badge-success]="zanzo.isHydrated()" [class.badge-error]="!zanzo.isHydrated()">
              {{ zanzo.isHydrated() ? 'Hydrated' : 'Idle' }}
            </span>
          </div>
          
          <div class="action-list">
            <label class="form-label">1. Hydrate Identity</label>
            <button class="btn-primary" (click)="hydrateAdmin()">
              Hydrate: Admin User
            </button>
            <button (click)="hydrateViewer()">
              Hydrate: Viewer User
            </button>
            
            <div style="height: 1rem;"></div>

            <button class="btn-ghost" (click)="clear()">
              Purge Session
            </button>
          </div>
        </section>

        <!-- Live Status Monitor -->
        <section class="card-base section-box">
          <div class="section-header">
            <h3 class="section-title">Engine Monitor ({{ ws.activeWorkspace() }})</h3>
          </div>
          <div class="status-content">
            <div class="status-row">
              <span class="status-label">Workspace Access:</span>
              <span class="status-val has-access" [class.granted]="canAccessWorkspace()">
                {{ canAccessWorkspace() ? 'GRANTED' : 'DENIED' }}
              </span>
            </div>
            
            <p class="monitor-subtitle">Module: Ventas</p>
            <div class="monitor-items">
              @for (action of ['read', 'update', 'delete']; track action) {
                <div class="monitor-cell">
                  <code>{{ action }}</code>
                  <span class="access-indicator" [class.granted]="zanzo.can($any(action), $any('Module:' + ws.activeWorkspace() + '_ventas'))()">
                    {{ action }}
                  </span>
                </div>
              }
            </div>

            <p class="monitor-subtitle">Module: Stock</p>
            <div class="monitor-items">
              @for (action of ['read', 'update', 'delete']; track action) {
                <div class="monitor-cell">
                  <code>{{ action }}</code>
                  <span class="access-indicator" [class.granted]="zanzo.can($any(action), $any('Module:' + ws.activeWorkspace() + '_stock'))()">
                    {{ action }}
                  </span>
                </div>
              }
            </div>
            
            <p class="monitor-subtitle">Capabilities</p>
             <div class="monitor-items">
                <div class="monitor-cell">
                  <code>export_csv</code>
                  <span class="access-indicator" [class.granted]="zanzo.can('use', 'Capability:export_csv')()">
                    use
                  </span>
                </div>
            </div>
          </div>
        </section>
      </div>
    </div>

    <style>
      .page-header { margin-bottom: 2rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 1.5rem; }
      .page-title { font-size: 1.5rem; margin-bottom: 0.5rem; }
      .page-desc { color: var(--text-dim); font-size: 0.875rem; max-width: 600px; }
      
      .section-box { padding: 1.5rem; display: flex; flex-direction: column; gap: 1.5rem; }
      .section-header { display: flex; justify-content: space-between; align-items: flex-start; }
      .section-title { font-size: 1rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
      
      .action-list { display: flex; flex-direction: column; gap: 0.75rem; }
      .form-label { font-size: 0.75rem; font-weight: 600; color: var(--text-ghost); text-transform: uppercase; margin-bottom: -4px;}
      .form-select {
        background: var(--bg-card); border: 1px solid var(--border-subtle); color: var(--text-main);
        padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 0.875rem;
      }
      
      .btn-ghost { background: transparent; border-color: transparent; color: var(--error); }
      .btn-ghost:hover { background: rgba(255, 50, 50, 0.05); }

      .status-content { display: flex; flex-direction: column; gap: 0.5rem; }
      .status-row { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border-subtle); margin-bottom: 0.5rem;}
      .status-label { color: var(--text-ghost); }
      .status-val { font-weight: 700; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; background: rgba(255,50,50,0.1); color: var(--error); border: 1px solid rgba(255,50,50,0.1); }
      .status-val.granted { background: rgba(0,255,150,0.1); color: var(--success); border-color: rgba(0,255,150,0.1); }

      .monitor-subtitle { font-size: 0.75rem; font-weight: 600; color: var(--accent); margin-top: 0.5rem; }
      .monitor-items { display: grid; grid-template-columns: 1fr; gap: 6px; }
      .monitor-cell { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(0,0,0,0.2); border-radius: 4px; }
      
      .access-indicator { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; background: rgba(255,50,50,0.1); color: var(--error); border: 1px solid rgba(255,50,50,0.1); }
      .access-indicator.granted { background: rgba(0,255,150,0.1); color: var(--success); border-color: rgba(0,255,150,0.1); }
    </style>
  `
})
export class HydrationComponent {
  public zanzo = inject<ZanzoService<typeof schema>>(ZanzoService);
  public ws = inject(WorkspaceService);
  
  public canAccessWorkspace = computed(() => {
    return this.zanzo.can('access', `Workspace:${this.ws.activeWorkspace()}`)();
  });

  hydrateAdmin() {
    this.zanzo.hydrate(adminSnapshot, testExtension);
  }

  hydrateViewer() {
    this.zanzo.hydrate(viewerSnapshot, testExtension);
  }

  clear() {
    this.zanzo.clear();
  }
}
