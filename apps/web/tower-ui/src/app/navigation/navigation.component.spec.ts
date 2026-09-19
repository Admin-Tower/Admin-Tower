import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BreakpointObserver } from '@angular/cdk/layout';
import { MatSidenav } from '@angular/material/sidenav';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';

import { NavigationComponent } from './navigation.component';

describe('NavigationComponent', () => {
  let component: NavigationComponent;
  let fixture: ComponentFixture<NavigationComponent>;
  let handset: BehaviorSubject<{ matches: boolean }>;

  beforeEach(() => {
    handset = new BehaviorSubject<{ matches: boolean }>({ matches: false });
    TestBed.configureTestingModule({
      imports: [NavigationComponent],
      providers: [
        provideRouter([]),
        { provide: BreakpointObserver, useValue: { observe: () => handset } },
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
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('toggles the overlay navigation on handsets and closes it after selection', async () => {
    handset.next({ matches: true });
    fixture.detectChanges();
    await fixture.whenStable();

    const drawer = fixture.debugElement.query(By.directive(MatSidenav)).componentInstance as MatSidenav;
    expect(drawer.mode).toBe('over');
    expect(drawer.opened).toBe(false);

    const toggle = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    toggle.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(drawer.opened).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    (fixture.nativeElement.querySelector('a') as HTMLAnchorElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(drawer.opened).toBe(false);
  });
});
