/**
 * CollectionManager — read/write wrapper around Zotero's Collections API.
 * All mutations go through user-confirmed proposals; nothing is auto-applied.
 */

export type CollectionInfo = {
  id: number;
  key: string;
  name: string;
  parentID: number | null;
  childIDs: number[];
  itemKeys: string[];
};

export type PaperBrief = {
  itemKey: string;
  itemID: number;
  title: string;
  authors: string;
  year: string;
  domain: string;
  problem: string;
  collectionIDs: number[];
};

type CollectionMap = Map<number, CollectionInfo>;

function getLibraryID(): number {
  return (Zotero as any).Libraries?.userLibraryID ?? 1;
}

async function getTopLevelCollections(): Promise<any[]> {
  try {
    const libID = getLibraryID();
    let ids: number[];
    try {
      ids = await (Zotero as any).Collections.getAllIDs(libID);
    } catch (_) {
      ids = await (Zotero as any).Collections.getAllIDs();
    }
    if (!ids?.length) return [];
    const collections: any[] = await (Zotero as any).Collections.getAsync(ids);
    return collections.filter((c: any) => c && !c.deleted);
  } catch (e: any) {
    Zotero.debug("[RA] getTopLevelCollections error: " + (e?.message || e));
    return [];
  }
}

function buildCollectionTree(collections: any[]): CollectionMap {
  const map: CollectionMap = new Map();
  for (const c of collections) {
    map.set(c.id, {
      id: c.id,
      key: c.key,
      name: c.name,
      parentID: c.parentID || null,
      childIDs: [],
      itemKeys: [],
    });
  }
  for (const [, info] of map) {
    if (info.parentID && map.has(info.parentID)) {
      map.get(info.parentID)!.childIDs.push(info.id);
    }
  }
  return map;
}

export async function readAllCollections(): Promise<CollectionInfo[]> {
  const collections = await getTopLevelCollections();
  const map = buildCollectionTree(collections);

  for (const [id, info] of map) {
    try {
      const col = await (Zotero as any).Collections.getAsync(id);
      if (col) {
        const itemIDs: number[] = col.getChildItems?.(false, false) || [];
        const items = itemIDs.length ? await (Zotero.Items as any).getAsync(itemIDs) : [];
        info.itemKeys = items.filter((i: any) => i && !i.deleted).map((i: any) => i.key);
      }
    } catch (_) {
      info.itemKeys = [];
    }
  }

  return Array.from(map.values());
}

export async function readPaperBriefs(itemKeys: string[]): Promise<PaperBrief[]> {
  if (!itemKeys.length) return [];
  const libID = getLibraryID();
  const briefs: PaperBrief[] = [];

  for (const key of itemKeys) {
    try {
      const item = await (Zotero.Items as any).getByLibraryAndKeyAsync(libID, key);
      if (!item || item.deleted) continue;

      const collections: number[] = (item as any).getCollections?.() || [];
      const creators: any[] = (item as any).getCreators?.() || [];
      const firstAuthor = creators[0]
        ? `${creators[0].lastName || creators[0].name || ""}`
        : "";
      const etAl = creators.length > 1 ? " et al." : "";

      briefs.push({
        itemKey: key,
        itemID: item.id,
        title: item.getDisplayTitle?.() || item.getField?.("title") || "",
        authors: `${firstAuthor}${etAl}`,
        year: String(item.getField?.("date") || "").slice(0, 4),
        domain: "",
        problem: "",
        collectionIDs: collections,
      });
    } catch (_) {}
  }

  return briefs;
}

export async function createCollection(name: string, parentID?: number): Promise<number | null> {
  try {
    const col = new (Zotero as any).Collection();
    col.name = name;
    if (parentID) col.parentID = parentID;
    await col.saveTx();
    return col.id;
  } catch (e: any) {
    Zotero.debug("[RA] createCollection error: " + (e?.message || e));
    return null;
  }
}

export async function moveItemToCollection(itemKey: string, collectionID: number): Promise<boolean> {
  try {
    const libID = getLibraryID();
    const item = await (Zotero.Items as any).getByLibraryAndKeyAsync(libID, itemKey);
    if (!item) return false;
    (item as any).addToCollection(collectionID);
    await item.saveTx();
    return true;
  } catch (e: any) {
    Zotero.debug("[RA] moveItemToCollection error: " + (e?.message || e));
    return false;
  }
}

export async function removeItemFromCollection(itemKey: string, collectionID: number): Promise<boolean> {
  try {
    const libID = getLibraryID();
    const item = await (Zotero.Items as any).getByLibraryAndKeyAsync(libID, itemKey);
    if (!item) return false;
    (item as any).removeFromCollection(collectionID);
    await item.saveTx();
    return true;
  } catch (e: any) {
    Zotero.debug("[RA] removeItemFromCollection error: " + (e?.message || e));
    return false;
  }
}

export async function addTagToItem(itemKey: string, tag: string): Promise<boolean> {
  try {
    const libID = getLibraryID();
    const item = await (Zotero.Items as any).getByLibraryAndKeyAsync(libID, itemKey);
    if (!item) return false;
    (item as any).addTag(tag);
    await item.saveTx();
    return true;
  } catch (e: any) {
    Zotero.debug("[RA] addTagToItem error: " + (e?.message || e));
    return false;
  }
}
