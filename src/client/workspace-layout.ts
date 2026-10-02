/** Leave room for the preview and both splitters, even after resizing the window. */
export function workspacePaneWidths(width: number, sidebar?: number | null, files?: number | null) {
  const previewMinimum = 380;
  const splitterWidth = 10;
  const sidebarMax = Math.min(360, width - 280 - previewMinimum - splitterWidth);
  const sidebarWidth = Math.max(180, Math.min(sidebarMax, sidebar ?? (width <= 1150 ? 230 : 270)));
  const filesMax = Math.min(600, width - sidebarWidth - previewMinimum - splitterWidth);
  const filesWidth = Math.max(280, Math.min(filesMax, files ?? (width <= 1150 ? 350 : 410)));
  return { sidebarWidth, filesWidth, sidebarMax, filesMax };
}
