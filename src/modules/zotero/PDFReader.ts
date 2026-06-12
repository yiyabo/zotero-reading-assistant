/**
 * PDF Reader utilities
 * Adapted from zotero-gpt project
 */

type PageText = {
  page: number;
  text: string;
};

type TextChunk = {
  id: string;
  pages: number[];
  text: string;
  section: string;
};

type PaperContextOptions = {
  query?: string;
  item?: Zotero.Item | null;
  maxChars?: number;
  maxPages?: number;
  deepRead?: boolean;
  renderImages?: boolean;
  openReader?: boolean;
  onStats?: (stats: PaperContextStats) => void;
  onProgress?: (stage: string, current: number, total: number) => void;
};

export type PaperContextStats = {
  totalPages: number;
  pageLimit: number;
  pagesRead: number;
  chunksSelected: number;
  contextChars: number;
  hasMetadata: boolean;
  hasSelection: boolean;
  annotationCount: number;
  hasReader: boolean;
  imagePages: number;
  status: "full" | "partial" | "metadata-only" | "none";
};

export type PaperContextResult = {
  text: string;
  images: string[];
};

type PageTextResult = {
  pages: PageText[];
  totalPages: number;
  pageLimit: number;
};

const pageTextCache = new Map<string, PageText[]>();

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trim()}\n[truncated]`;
}

function getCurrentReader(): any | null {
  try {
    if ((Zotero_Tabs as any)?.selectedType === "reader") {
      return Zotero.Reader.getByTabID((Zotero_Tabs as any).selectedID) || null;
    }
  } catch (_) {}
  try {
    const readers = (Zotero.Reader as any)._readers || [];
    if (readers.length > 0) return readers[readers.length - 1];
  } catch (_) {}
  return null;
}

function getReaderForItem(item: Zotero.Item | null): any | null {
  if (!item) return null;
  try {
    const current = getCurrentReader();
    if (current) {
      Zotero.debug("[RA] getReaderForItem: found current reader, itemID=" + current.itemID);
      return current;
    }

    const readers = (Zotero.Reader as any)._readers || [];
    const targetIDs = new Set<number>();

    if (typeof (item as any).getAnnotations === "function") {
      targetIDs.add(item.id);
    } else if (typeof (item as any).getAttachments === "function") {
      (item as any)
        .getAttachments()
        .map((id: number) => Zotero.Items.get(id))
        .filter((att: any) => typeof att?.getAnnotations === "function")
        .forEach((att: any) => targetIDs.add(att.id));
    } else {
      targetIDs.add(item.id);
    }

    Zotero.debug("[RA] getReaderForItem: searching " + readers.length + " readers for IDs: " + [...targetIDs].join(", "));

    for (const reader of readers) {
      if (reader.itemID && targetIDs.has(reader.itemID)) {
        Zotero.debug("[RA] getReaderForItem: found reader in _readers, itemID=" + reader.itemID);
        return reader;
      }
    }

    Zotero.debug("[RA] getReaderForItem: no reader found among open tabs");
  } catch (error: any) {
    Zotero.debug("[RA] Failed to get reader for item: " + error.message);
  }
  return null;
}

async function ensureReaderForItem(item: Zotero.Item | null): Promise<any | null> {
  let reader = getReaderForItem(item);
  if (reader) return reader;

  if (!item) return null;

  try {
    const attachments = getAnnotationSourceItems(item);
    if (attachments.length) {
      const attID = attachments[0].id;
      Zotero.debug("[RA] ensureReaderForItem: opening reader for attachment " + attID);
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      const readerTab = Zotero.Reader.open(attID);
      // Wait up to 20 seconds for the reader to initialize
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        reader = getReaderForItem(item);
        if (reader) {
          Zotero.debug("[RA] ensureReaderForItem: reader ready after " + ((i + 1) * 0.5) + "s");
          return reader;
        }
      }
      Zotero.debug("[RA] ensureReaderForItem: timed out waiting for reader");
    }
  } catch (error: any) {
    Zotero.debug("[RA] ensureReaderForItem: error opening reader: " + error.message);
  }
  return null;
}

function getReaderIframeWindow(reader: any): any | null {
  return (
    reader?._iframeWindow ||
    reader?._internalReader?._iframeWindow ||
    reader?._internalReader?._iframe?.contentWindow ||
    reader?._internalReader?._primaryView?._iframeWindow ||
    null
  );
}

function getParentItem(item: Zotero.Item | null): Zotero.Item | null {
  if (!item) return null;

  try {
    const parentID = (item as any).parentID;
    return parentID ? (Zotero.Items.get(parentID) as Zotero.Item) : item;
  } catch (error) {
    Zotero.debug("Failed to get parent item: " + error);
    return item;
  }
}

function getAnnotationSourceItems(item: Zotero.Item | null): Zotero.Item[] {
  if (!item) return [];

  try {
    if (typeof (item as any).getAnnotations === "function") {
      return [item];
    }

    if (typeof (item as any).getAttachments === "function") {
      return (item as any)
        .getAttachments()
        .map((idOrItem: any) => {
          if (typeof idOrItem === "number") return Zotero.Items.get(idOrItem);
          return idOrItem;
        })
        .filter((att: any) => att && typeof att?.getAnnotations === "function");
    }

    // For parent items that don't have getAttachments, check if this item IS an attachment
    const itemType = Zotero.ItemTypes.getName((item as any).itemTypeID);
    if (itemType === "attachment") {
      return [item];
    }
  } catch (error) {
    Zotero.debug("[RA] Failed to get annotation source items: " + error);
  }

  return [];
}

function formatCreators(item: Zotero.Item): string {
  try {
    return item
      .getCreators()
      .map((creator: any) => `${creator.firstName || ""} ${creator.lastName || ""}`.trim())
      .filter(Boolean)
      .join(", ");
  } catch (error) {
    return "";
  }
}

async function renderPageToImage(
  reader: any,
  pageNumber: number,
  scale: number = 1.5,
  maxWidth: number = 1200
): Promise<string | null> {
  try {
    const app = await getPDFViewerApplication(reader);
    if (!app) return null;

    const pageView = app.pdfViewer?._pages?.[pageNumber - 1];
    if (!pageView) return null;

    const pdfPage = pageView.pdfPage || (await app.pdfDocument?.getPage(pageNumber));
    if (!pdfPage) return null;

    const viewport = pdfPage.getViewport({ scale });
    const iframeWindow = getReaderIframeWindow(reader);
    const canvasDoc = iframeWindow?.document || document;
    const canvas = canvasDoc.createElementNS("http://www.w3.org/1999/xhtml", "canvas") as HTMLCanvasElement;
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const renderTask = pdfPage.render({ canvasContext: ctx, viewport });
    await renderTask.promise;

    if (canvas.width > maxWidth) {
      const factor = maxWidth / canvas.width;
      const smallCanvas = canvasDoc.createElementNS("http://www.w3.org/1999/xhtml", "canvas") as HTMLCanvasElement;
      smallCanvas.width = maxWidth;
      smallCanvas.height = Math.round(canvas.height * factor);
      const smallCtx = smallCanvas.getContext("2d");
      if (smallCtx) {
        smallCtx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
        const dataUrl = smallCanvas.toDataURL("image/jpeg", 0.82);
        smallCanvas.width = 0; smallCanvas.height = 0;
        canvas.width = 0; canvas.height = 0;
        return dataUrl;
      }
    }

    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    canvas.width = 0; canvas.height = 0;
    return dataUrl;
  } catch (error: any) {
    Zotero.debug("Failed to render page " + pageNumber + " to image: " + error.message);
    return null;
  }
}

async function getFullTextFromIndex(item: Zotero.Item | null): Promise<PageTextResult> {
  if (!item) return { pages: [], totalPages: 0, pageLimit: 0 };

  try {
    const attachments = getAnnotationSourceItems(item);
    if (!attachments.length) return { pages: [], totalPages: 0, pageLimit: 0 };

    const allPages: PageText[] = [];
    let totalPages = 0;

    for (const attachment of attachments) {
      Zotero.debug("Trying fulltext index for attachment " + attachment.id);
      const fulltext = await (Zotero.Fulltext as any).getItemFullText(attachment.id);
      if (!fulltext) continue;

      const rawText = typeof fulltext === "string" ? fulltext : fulltext.text || "";
      const text = normalizeText(rawText);
      if (!text) continue;

      totalPages = (typeof fulltext === "object" ? fulltext.totalPages : 0) || 0;

      const SEGMENT_SIZE = 4500;
      if (text.length <= SEGMENT_SIZE) {
        allPages.push({ page: 1, text });
      } else {
        let offset = 0;
        let pageNum = 1;
        while (offset < text.length) {
          const segment = text.slice(offset, offset + SEGMENT_SIZE).trim();
          if (segment) {
            allPages.push({ page: pageNum, text: segment });
            pageNum++;
          }
          offset += SEGMENT_SIZE;
        }
        if (!totalPages) totalPages = pageNum - 1;
      }
    }

    return { pages: allPages, totalPages: totalPages || allPages.length, pageLimit: totalPages || allPages.length };
  } catch (error: any) {
    Zotero.debug("Failed to get full text from index: " + error.message);
    return { pages: [], totalPages: 0, pageLimit: 0 };
  }
}

async function getPDFViewerApplication(reader: any): Promise<any | null> {
  try {
    await reader?._initPromise;
    await reader?._internalReader?._initPromise;
    const iframeWindow = getReaderIframeWindow(reader);
    const app = iframeWindow?.wrappedJSObject?.PDFViewerApplication || iframeWindow?.PDFViewerApplication;
    if (!app) return null;

    await app.pdfLoadingTask?.promise;
    await app.pdfViewer?.pagesPromise;
    return app;
  } catch (error: any) {
    Zotero.debug("Failed to get PDFViewerApplication: " + error.message);
    return null;
  }
}

async function getPDFPageTexts(
  reader: any,
  item: Zotero.Item | null,
  maxPages: number = 80
): Promise<PageTextResult> {
  if (!reader) return { pages: [], totalPages: 0, pageLimit: 0 };

  const app = await getPDFViewerApplication(reader);
  if (!app) return { pages: [], totalPages: 0, pageLimit: 0 };

  const totalPages = Number(app.pagesCount || app.pdfDocument?.numPages || app.pdfViewer?._pages?.length || 0);
  if (!totalPages) return { pages: [], totalPages: 0, pageLimit: 0 };
  const pageLimit = Math.min(totalPages, maxPages);

  const cacheKey = `${(item as any)?.key || reader.itemID || "reader"}:${totalPages}:${pageLimit}`;
  const cached = pageTextCache.get(cacheKey);
  if (cached) return { pages: cached, totalPages, pageLimit };

  const pageTexts: PageText[] = [];

  for (let index = 0; index < pageLimit; index++) {
    try {
      const pageView = app.pdfViewer?._pages?.[index];
      const pdfPage = pageView?.pdfPage || (await app.pdfDocument?.getPage(index + 1));
      if (!pdfPage) continue;

      const textContent = await pdfPage.getTextContent();
      const text = normalizeText(
        (textContent.items || [])
          .map((textItem: any) => textItem.str || "")
          .filter(Boolean)
          .join(" ")
      );

      if (text) {
        pageTexts.push({ page: index + 1, text });
      }
    } catch (error: any) {
      Zotero.debug(`Failed to read PDF page ${index + 1}: ${error.message}`);
    }
  }

  pageTextCache.set(cacheKey, pageTexts);
  return { pages: pageTexts, totalPages, pageLimit };
}

function getCurrentPageNumber(reader: any): number {
  try {
    const iframeWindow = getReaderIframeWindow(reader);
    const app = iframeWindow?.wrappedJSObject?.PDFViewerApplication || iframeWindow?.PDFViewerApplication;
    return Number(app?.pdfViewer?.currentPageNumber || app?.page || 1);
  } catch (error) {
    return 1;
  }
}

/**
 * Get selected text from current PDF reader
 */
export async function getPDFSelection(item?: Zotero.Item | null): Promise<string> {
  try {
    const reader = item ? getReaderForItem(item) : getCurrentReader();
    if (!reader) return "";

    const annotation = (reader as any)._internalReader?._lastView?._selectionPopup?.annotation;
    const annotationText = annotation?.text || "";
    if (annotationText.trim()) {
      return annotationText.trim();
    }

    const selectionText = getReaderIframeWindow(reader)?.getSelection?.().toString?.() || "";
    return selectionText.trim();
  } catch (error: any) {
    Zotero.debug("Failed to get PDF selection: " + error.message);
    return "";
  }
}

/**
 * Get current PDF item
 */
export function getCurrentPDFItem(): Zotero.Item | null {
  try {
    const reader = getCurrentReader();
    if (!reader || !reader.itemID) {
      return null;
    }

    return Zotero.Items.get(reader.itemID) as Zotero.Item;
  } catch (error) {
    Zotero.debug("Failed to get current PDF item: " + error);
    return null;
  }
}

/**
 * Check if currently viewing a PDF
 */
export function isViewingPDF(): boolean {
  return getCurrentPDFItem() !== null;
}

/**
 * Get PDF file path
 */
export function getPDFPath(): string | null {
  const item = getCurrentPDFItem();
  if (!item) {
    return null;
  }

  try {
    const path = item.getFilePath();
    return typeof path === "string" ? path : null;
  } catch (error) {
    Zotero.debug("Failed to get PDF path: " + error);
    return null;
  }
}

/**
 * Get PDF annotations
 */
export function getPDFAnnotations(selectedOnly: boolean = false, item?: Zotero.Item | null): string[] {
  const targetItem = item || getCurrentPDFItem();
  if (!targetItem) {
    return [];
  }

  try {
    const texts: string[] = [];
    for (const sourceItem of getAnnotationSourceItems(targetItem)) {
      const annotations = (sourceItem as any).getAnnotations();
      for (const anno of annotations) {
        if (selectedOnly) {
          // TODO: Check if annotation is selected.
        }

        const text = anno.annotationText;
        if (text && text.trim()) {
          texts.push(text.trim());
        }
      }
    }

  return texts;
  } catch (error) {
    Zotero.debug("Failed to get PDF annotations: " + error);
    return [];
  }
}

/**
 * Navigate the PDF reader to a specific page
 */
export function navigateToPDFPage(page: number): void {
  try {
    const reader = getCurrentReader();
    if (!reader) return;
    const iframeWindow = getReaderIframeWindow(reader);
    const app = iframeWindow?.wrappedJSObject?.PDFViewerApplication || iframeWindow?.PDFViewerApplication;
    if (app?.pdfViewer && page >= 1) {
      app.pdfViewer.currentPageNumber = page;
    }
  } catch (e: any) {
    Zotero.debug("[RA] navigateToPage failed: " + (e.message || e));
  }
}

/**
 * Get PDF metadata
 */
export function getPDFMetadata(item?: Zotero.Item | null): {
  title: string;
  authors: string;
  year: string;
  abstract: string;
} | null {
  const currentItem = item || getCurrentPDFItem();
  if (!currentItem) {
    return null;
  }

  try {
    const parentItem = getParentItem(currentItem) || currentItem;
    const date = String(parentItem.getField("date") || "");

    return {
      title: String(parentItem.getField("title") || parentItem.getDisplayTitle?.() || ""),
      authors: formatCreators(parentItem),
      year: date.match(/\d{4}/)?.[0] || "",
      abstract: String(parentItem.getField("abstractNote") || ""),
    };
  } catch (error) {
    Zotero.debug("Failed to get PDF metadata: " + error);
    return null;
  }
}

export async function buildCurrentPaperContext(options: PaperContextOptions = {}): Promise<PaperContextResult> {
  const query = options.query || "";
  const deepRead = !!options.deepRead;
  const maxChars = options.maxChars || (deepRead ? 1000000 : 250000);
  const currentItem = options.item || getCurrentPDFItem();
  const parentItem = getParentItem(currentItem);
  const targetItem = currentItem || parentItem;
  let reader = options.openReader === false
    ? getReaderForItem(targetItem)
    : await ensureReaderForItem(targetItem);
  const sections: string[] = [];
  const images: string[] = [];
  const stats: PaperContextStats = {
    totalPages: 0,
    pageLimit: options.maxPages || (deepRead ? 1000 : 200),
    pagesRead: 0,
    chunksSelected: 0,
    contextChars: 0,
    hasMetadata: false,
    hasSelection: false,
    annotationCount: 0,
    hasReader: false,
    imagePages: 0,
    status: "none",
  };

  try {
    const metadata = getPDFMetadata(targetItem);
    if (metadata) {
      const metadataLines = [
        metadata.title ? `Title: ${metadata.title}` : "",
        metadata.authors ? `Authors: ${metadata.authors}` : "",
        metadata.year ? `Year: ${metadata.year}` : "",
        metadata.abstract ? `Abstract: ${truncateText(metadata.abstract, 3500)}` : "",
      ].filter(Boolean);

      if (metadataLines.length) {
        stats.hasMetadata = true;
        sections.push(`Paper metadata\n${metadataLines.join("\n")}`);
      }
    }

    const selection = await getPDFSelection(targetItem);
    if (selection) {
      stats.hasSelection = true;
      sections.push(`Currently selected PDF text\n${truncateText(selection, 2500)}`);
    }

    const annotations = getPDFAnnotations(false, targetItem);
    stats.annotationCount = annotations.length;
    if (annotations.length) {
      sections.push(
        `PDF annotations\n${truncateText(
          annotations.map((text, index) => `[Annotation ${index + 1}] ${text}`).join("\n\n"),
          4500
        )}`
      );
    }

    options.onProgress?.("Extracting text", 0, 1);

    let pageTextResult = await getPDFPageTexts(
      reader,
      targetItem,
      options.maxPages || (deepRead ? 1000 : 200)
    );

    if (!pageTextResult.pages.length && targetItem) {
      Zotero.debug("Reader extraction returned empty, falling back to fulltext index");
      pageTextResult = await getFullTextFromIndex(targetItem);
      if (pageTextResult.pages.length) {
        reader = null;
      }
    }

    const pageTexts = pageTextResult.pages;
    stats.totalPages = pageTextResult.totalPages;
    stats.pageLimit = pageTextResult.pageLimit;
    stats.pagesRead = pageTexts.length;
    stats.hasReader = !!reader || pageTexts.length > 0;

    if (pageTexts.length) {
      const currentPage = reader ? getCurrentPageNumber(reader) : 1;

      // Render ALL pages concurrently (batch of 4) for ~4x speedup
      if (reader && options.renderImages) {
        const totalToRender = Math.min(pageTexts.length, 50);
        const CONCURRENT = 4;
        let renderedCount = 0;
        for (let batch = 1; batch <= totalToRender; batch += CONCURRENT) {
          const batchEnd = Math.min(batch + CONCURRENT - 1, totalToRender);
          const batchPages: number[] = [];
          for (let p = batch; p <= batchEnd; p++) batchPages.push(p);
          const results = await Promise.all(
            batchPages.map((pageNum) => renderPageToImage(reader, pageNum, 1.5, 1200))
          );
          for (const data of results) {
            if (data) images.push(data);
            renderedCount++;
          }
          options.onProgress?.("Rendering pages", renderedCount, totalToRender);
        }
        stats.imagePages = images.length;
        Zotero.debug(`Rendered ${images.length} PDF pages to images for vision model`);
      }

      // Send FULL text of all pages — no chunk filtering, Web-style
      const fullPageText = pageTexts
        .map((page) => `[Page ${page.page}]\n${page.text}`)
        .join("\n\n");

      if (fullPageText) {
        sections.push(
          `Full paper text (${pageTexts.length} pages)\nCurrent page: ${currentPage}\n\n${fullPageText}`
        );
      }
    }
  } catch (error: any) {
    Zotero.debug("Failed to build paper context: " + error.message);
  }

  const context = truncateText(sections.join("\n\n---\n\n"), maxChars);
  stats.contextChars = context.length;
  if (stats.pagesRead > 0 && stats.totalPages > 0 && stats.pagesRead >= Math.min(stats.totalPages, stats.pageLimit)) {
    stats.status = stats.pagesRead >= stats.totalPages ? "full" : "partial";
  } else if (stats.hasMetadata || stats.hasSelection || stats.annotationCount > 0) {
    stats.status = "metadata-only";
  } else {
    stats.status = "none";
  }
  options.onStats?.(stats);
  return { text: context, images };
}

/**
 * Get context for AI query
 * Returns selected text, or annotations, or metadata
 */
export async function getPDFContext(): Promise<{
  type: "selection" | "annotations" | "metadata" | "none";
  content: string;
}> {
  const selection = await getPDFSelection();
  if (selection) {
    return {
      type: "selection",
      content: selection,
    };
  }

  const annotations = getPDFAnnotations();
  if (annotations.length > 0) {
    return {
      type: "annotations",
      content: annotations.join("\n\n"),
    };
  }

  const metadata = getPDFMetadata();
  if (metadata) {
    let content = `Title: ${metadata.title}\n`;
    if (metadata.authors) {
      content += `Authors: ${metadata.authors}\n`;
    }
    if (metadata.year) {
      content += `Year: ${metadata.year}\n`;
    }
    if (metadata.abstract) {
      content += `\nAbstract:\n${metadata.abstract}`;
    }
    return {
      type: "metadata",
      content,
    };
  }

  return {
    type: "none",
    content: "",
  };
}
