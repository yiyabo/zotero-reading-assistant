export function openItemInZotero(itemID: number): void {
  try {
    const win = (Services as any).wm.getMostRecentWindow("navigator:browser") as any;
    if (!win?.ZoteroPane) return;
    win.ZoteroPane.selectItem(itemID);
    try { win.focus(); } catch (_) {}
  } catch (e: any) {
    Zotero.debug("[RA] openItemInZotero error: " + (e?.message || e));
  }
}

export function findPdfAttachmentID(itemID: number): number | null {
  try {
    const item = Zotero.Items.get(itemID) as any;
    if (!item) return null;
    const attIds: number[] = item.getAttachments?.() || [];
    for (const aid of attIds) {
      const att = Zotero.Items.get(aid) as any;
      if (!att) continue;
      const ct = att.attachmentContentType || att.getField?.("contentType");
      if (ct === "application/pdf") return aid;
    }
  } catch (e: any) {
    Zotero.debug("[RA] findPdfAttachmentID error: " + (e?.message || e));
  }
  return null;
}

export function hasPdfAttachment(itemID: number): boolean {
  return findPdfAttachmentID(itemID) != null;
}

export async function openItemInReader(itemID: number): Promise<void> {
  const pdfId = findPdfAttachmentID(itemID);
  if (pdfId == null) return;
  try {
    await (Zotero.Reader as any).open(pdfId);
    try {
      const win = (Services as any).wm.getMostRecentWindow("navigator:browser") as any;
      win?.focus?.();
    } catch (_) {}
  } catch (e: any) {
    Zotero.debug("[RA] openItemInReader error: " + (e?.message || e));
  }
}
