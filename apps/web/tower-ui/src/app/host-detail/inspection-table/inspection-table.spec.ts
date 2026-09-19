import { TestBed } from '@angular/core/testing';
import { InspectionTable } from './inspection-table';

const section = { id: 'processes', status: 'ok', truncated: false, output: Array.from({ length: 62 }, (_, i) => `${i + 1} 1 user${i % 2} ${i + 1}.0 1.0 ${i % 2 ? 'S' : 'R'} process-${i + 1}`).join('\n') };

describe('InspectionTable', () => {
  async function setup() {
    await TestBed.configureTestingModule({ imports: [InspectionTable] }).compileComponents();
    const fixture = TestBed.createComponent(InspectionTable);
    fixture.componentRef.setInput('section', section); fixture.componentRef.setInput('title', 'Processes');
    await fixture.whenStable(); return fixture;
  }
  it('sorts numerically with accessible headers and paginates before rendering', async () => {
    const fixture = await setup(), table = fixture.componentInstance;
    expect(table.visible()).toHaveLength(25); expect(table.visible()[0][0]).toBe('62');
    expect(fixture.nativeElement.querySelectorAll('tbody tr')).toHaveLength(25);
    expect(fixture.nativeElement.querySelector('[aria-sort="descending"]').textContent).toContain('CPU %');
    table.sortBy(0); expect(table.visible()[0][0]).toBe('1');
    table.page.set(2); expect(table.visible()).toHaveLength(12);
    table.resize(50); expect(table.currentPage()).toBe(0); expect(table.visible()).toHaveLength(50);
  });
  it('combines case-insensitive search and state filtering, resetting page', async () => {
    const fixture = await setup(), table = fixture.componentInstance;
    table.page.set(2); table.search('USER1 process'); table.filterState('S');
    expect(table.currentPage()).toBe(0); expect(table.filtered()).toHaveLength(31);
    table.search('not found'); await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('No records match your filters.');
    table.clear(); expect(table.filtered()).toHaveLength(62);
  });
  it('clamps pagination after refreshing a smaller result set', async () => {
    const fixture = await setup(), table = fixture.componentInstance;
    table.page.set(2); fixture.componentRef.setInput('section', { ...section, output: '1 0 root 1.0 1.0 S init' });
    await fixture.whenStable(); expect(table.currentPage()).toBe(0); expect(table.visible()).toHaveLength(1);
  });
  it('keeps diagnostics collapsed and distinguishes missing data from empty results', async () => {
    const fixture = await setup(); fixture.componentRef.setInput('section', { id: 'nftables', status: 'denied', output: 'Operation not permitted', truncated: false });
    await fixture.whenStable(); expect(fixture.nativeElement.querySelector('table')).toBeNull();
    expect(fixture.nativeElement.querySelector('details').open).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('cannot read this information');
  });
});
