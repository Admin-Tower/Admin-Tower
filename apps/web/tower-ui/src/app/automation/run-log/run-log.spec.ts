import { TestBed } from '@angular/core/testing';
import { RunLog } from './run-log';

describe('RunLog', () => {
  it('renders incremental output as text and lets the user stop following', async () => {
    const fixture = TestBed.createComponent(RunLog);
    fixture.componentRef.setInput('text', '$ apt-get update\nfirst line');
    await fixture.whenStable();
    const output = fixture.nativeElement.querySelector('[role="log"]') as HTMLElement;
    Object.defineProperty(output, 'scrollHeight', { value: 500 });
    fixture.componentRef.setInput('text', '$ apt-get update\n<img src=x onerror=alert(1)>');
    await fixture.whenStable();
    expect(output.textContent).toContain('<img src=x');
    expect(output.querySelector('img')).toBeNull();
    expect(output.scrollTop).toBe(500);
    const follow = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    follow.click();
    output.scrollTop = 10;
    fixture.componentRef.setInput('text', 'later output');
    fixture.componentRef.setInput('error', 'Log connection unavailable; task continues.');
    await fixture.whenStable();
    expect(output.scrollTop).toBe(10);
    expect(fixture.nativeElement.textContent).toContain('task continues');
  });
});
