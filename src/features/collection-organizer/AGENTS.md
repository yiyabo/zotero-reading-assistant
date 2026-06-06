# Collection Organizer Feature

## OVERVIEW

AI-assisted collection management. Analyzes papers in the library and proposes collection reorganizations. All changes require user confirmation — nothing is auto-applied.

## STRUCTURE

```
collection-organizer/
├── CollectionManager.ts    # Read/write wrapper around Zotero Collections API
├── CollectionAnalyzer.ts   # LLM-based analysis of paper→collection fit
└── OrganizerPage.ts        # UI for reviewing and applying proposals
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Collection tree reading | `CollectionManager.ts:getTopLevelCollections` | Reads Zotero collections hierarchy |
| Paper briefs | `CollectionManager.ts:PaperBrief` | Structured paper summary for LLM analysis |
| Proposal generation | `CollectionAnalyzer.ts` | Sends paper briefs + collection tree to LLM |
| User review UI | `OrganizerPage.ts` | Shows proposals, lets user accept/reject each |

## CONVENTIONS

- **Proposal-only**: The analyzer generates proposals. The user must confirm each one. Never auto-apply collection changes.
- **CollectionInfo type**: `{ id, key, name, parentID, childIDs, itemKeys }` — the basic unit for all collection operations.
