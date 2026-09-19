import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MatSidenav } from '@angular/material/sidenav';
import { BreakpointObserver } from '@angular/cdk/layout';
import { BehaviorSubject } from 'rxjs';
import { By } from '@angular/platform-browser';

import { NavigationComponent } from './navigation.component';

describe('NavigationComponent', () => {
  let component: NavigationComponent;
  let viewport: BehaviorSubject<{ matches: boolean }>;
  let fixture: ComponentFixture<NavigationComponent>;

  beforeEach(() => {
    viewport = new BehaviorSubject<{ matches: boolean }>({ matches: false });
    TestBed.configureTestingModule({
      imports: [NavigationComponent],
      providers: [
        provideRouter([{ path: 'hosts', children: [] }]),
        { provide: BreakpointObserver, useValue: { observe: () => viewport } },
      ],
    });
    fixture = TestBed.createComponent(NavigationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should compile', () => {
    expect(component).toBeTruthy();
  });

  it('keeps the navigation open on desktop', () => {
    const drawer = fixture.debugElement.query(By.directive(MatSidenav)).componentInstance as MatSidenav;
    expect(drawer.mode).toBe('side');
    expect(drawer.opened).toBe(true);
    expect(fixture.nativeElement.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('a[href="/hosts"]')?.textContent).toContain('Hosts');
  });

  it('switches to a closed overlay on narrow screens', async () => {
    viewport.next({ matches: true });
    await fixture.whenStable();
    const drawer = fixture.debugElement.query(By.directive(MatSidenav)).componentInstance as MatSidenav;
    expect(drawer.mode).toBe('over');
    expect(drawer.opened).toBe(false);
    viewport.next({ matches: false });
    await fixture.whenStable();
    expect(drawer.mode).toBe('side');
    expect(drawer.opened).toBe(true);
  });

  it('toggles the side navigation and keeps it open after desktop selection', async () => {
    const drawer = fixture.debugElement.query(By.directive(MatSidenav)).componentInstance as MatSidenav;
    expect(drawer.mode).toBe('side');
    expect(drawer.opened).toBe(true);

    const toggle = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(drawer.opened).toBe(false);
    toggle.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(drawer.opened).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    (fixture.nativeElement.querySelector('a') as HTMLAnchorElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(drawer.opened).toBe(true);
  });
});
