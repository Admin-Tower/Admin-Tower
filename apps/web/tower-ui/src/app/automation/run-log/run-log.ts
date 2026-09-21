import { Component, ElementRef, afterRenderEffect, input, signal, viewChild } from '@angular/core';

@Component({
  selector: 'tower-run-log',
  templateUrl: './run-log.html',
})
export class RunLog {
  readonly text = input('');
  readonly error = input('');
  readonly label = input('Live logs');
  readonly follow = signal(true);
  private readonly output = viewChild<ElementRef<HTMLElement>>('output');

  constructor() {
    afterRenderEffect(() => {
      this.text();
      const element = this.output()?.nativeElement;
      if (this.follow() && element) element.scrollTop = element.scrollHeight;
    });
  }
}
