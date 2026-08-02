export type AINote = {
  id: string;
  number: number;
  attachmentKey: string;
  parentItemKey: string;
  pageIndex: number;
  /** PDF-space rect [x1, y1, x2, y2], origin bottom-left. */
  rect: [number, number, number, number];
  content: string;
  color: string;
  createdAt: number;
  updatedAt: number;
  /** Optional native Zotero annotation key when dual-written. */
  zoteroAnnotationKey?: string;
};

export type AINotesFile = {
  version: 1;
  attachmentKey: string;
  parentItemKey: string;
  notes: AINote[];
};

export type AINotesChangeListener = (attachmentKey: string) => void;

export const DEFAULT_NOTE_COLOR = "#7c3aed";
export const DEFAULT_NOTE_WIDTH = 220;
export const DEFAULT_NOTE_HEIGHT = 140;
