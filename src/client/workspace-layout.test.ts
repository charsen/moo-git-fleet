import { expect, it } from 'vitest';
import { workspacePaneWidths } from './workspace-layout';
it('grows both default panes and keeps a usable preview at supported widths and resized extremes', () => {
  expect(workspacePaneWidths(1440)).toMatchObject({ sidebarWidth: 270, filesWidth: 410 });
  expect(workspacePaneWidths(1024)).toMatchObject({ sidebarWidth: 230, filesWidth: 350 });
  for (const width of [1024, 1150, 1440, 1920]) for (const sidebar of [null, 180, 360, 999]) for (const files of [null, 280, 600, 999]) {
    const panes = workspacePaneWidths(width, sidebar, files);
    expect(panes.sidebarWidth).toBeGreaterThanOrEqual(180); expect(panes.filesWidth).toBeGreaterThanOrEqual(280);
    expect(width - panes.sidebarWidth - panes.filesWidth - 10).toBeGreaterThanOrEqual(380);
  }
});
