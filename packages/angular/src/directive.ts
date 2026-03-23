import { 
  Directive, 
  Input, 
  TemplateRef, 
  ViewContainerRef, 
  inject, 
  effect,
  input
} from '@angular/core';
import { ZanzoService } from './service.js';

export interface ZanzoIfContext {
  action: string;
  resource: `${string}:${string}`;
}

/**
 * Structural directive for conditional rendering based on ZanzoJS permissions.
 * Replaces the need for complex *ngIf + pipe combinations.
 * 
 * @example
 * ```html
 * <div *zanzoIf="{ action: 'edit', resource: 'Module:ventas' }; else noAccess">
 *   Admin Content
 * </div>
 * <ng-template #noAccess>Denied</ng-template>
 * ```
 */
@Directive({
  selector: '[zanzoIf]',
  standalone: true
})
export class ZanzoIfDirective {
  private readonly zanzo = inject(ZanzoService);
  private readonly templateRef = inject(TemplateRef<unknown>);
  private readonly viewContainer = inject(ViewContainerRef);

  /**
   * Input for the permission context: { action, resource }.
   */
  public readonly zanzoIf = input.required<ZanzoIfContext>();

  /**
   * Optional else template fallback.
   */
  @Input() public zanzoIfElse?: TemplateRef<unknown>;

  private hasView = false;

  constructor() {
    // Reactively update the view container when the permission signal changes
    effect(() => {
      const context = this.zanzoIf();
      const signal = this.zanzo._canInternal(context.action, context.resource);
      const isAllowed = signal();

      if (isAllowed && !this.hasView) {
        this.viewContainer.clear();
        this.viewContainer.createEmbeddedView(this.templateRef);
        this.hasView = true;
      } else if (!isAllowed && (this.hasView || this.viewContainer.length === 0)) {
        this.viewContainer.clear();
        if (this.zanzoIfElse) {
          this.viewContainer.createEmbeddedView(this.zanzoIfElse);
        }
        this.hasView = false;
      }
    });
  }
}
