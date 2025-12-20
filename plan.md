# Run History Feature - Implementation Plan

## Overview
Add persistent storage for all generation runs with a gallery UI to browse, review, and manage history.

## Data Model

### `runs` Table Schema
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Auto-increment ID |
| created_at | TEXT | ISO 8601 timestamp |
| model_id | TEXT | OpenRouter model ID (e.g., `openai/gpt-image-1`) |
| model_label | TEXT | Human-readable model name |
| prompt_template | TEXT | The prompt template used |
| compiled_prompt | TEXT | The final prompt sent to the API |
| new_title | TEXT | The title text to insert |
| input_image | TEXT | Base64 data URL of input image |
| output_image | TEXT | Base64 data URL of output image |
| served_by | TEXT | Provider that served the request |
| route | TEXT | OpenRouter route info |
| prompt_tokens | INTEGER | Input tokens used |
| completion_tokens | INTEGER | Output tokens used |
| total_tokens | INTEGER | Total tokens used |
| cost | REAL | Cost in USD |
| duration_ms | INTEGER | Generation time in milliseconds |
| human_comment | TEXT | User notes on quality |
| error | TEXT | Error message if generation failed (nullable) |

> **Note:** API key is intentionally NOT stored for security reasons.

## UI Changes

### 1. History Gallery Panel
- Add a collapsible/toggleable history panel (sidebar or modal)
- Display runs as thumbnail cards showing:
  - Input/output image thumbnails
  - Date/time
  - Model used
  - Cost & duration
  - First few words of title
  - Comment preview (if any)
- Click to expand and see full details

### 2. Run Detail View
- Show full input and output images side-by-side
- Display all metadata (model, tokens, cost, duration, etc.)
- Editable comment field
- "Delete" button with confirmation
- "Load" button to restore this run's settings to the editor

### 3. Current Run Integration
- After each successful generation, auto-save to database
- Show "Add Comment" field in the existing metrics panel
- Add "View History" button in header or sidebar

## Technical Implementation

### Phase 1: Database Setup
1. Add `sql.js` (SQLite compiled to WebAssembly) or `@electric-sql/pglite` for in-browser SQLite
2. Create database initialization module
3. Implement CRUD operations for runs
4. Handle database persistence to IndexedDB for durability

### Phase 2: Data Layer
1. Create `src/lib/db.ts` with:
   - `initDatabase()` - Initialize/open database
   - `saveRun(run)` - Insert new run
   - `getRuns(limit, offset)` - Paginated fetch
   - `getRunById(id)` - Single run fetch
   - `updateRunComment(id, comment)` - Update comment
   - `deleteRun(id)` - Delete run
2. Create TypeScript types for run data

### Phase 3: UI Components
1. `src/components/HistoryGallery.tsx` - Gallery view
2. `src/components/RunCard.tsx` - Thumbnail card
3. `src/components/RunDetail.tsx` - Full detail view
4. `src/components/CommentEditor.tsx` - Comment input

### Phase 4: Integration
1. Hook into `generate()` to auto-save runs
2. Add history button to header
3. Add comment field to metrics panel
4. Implement "load from history" functionality

## Dependencies to Add
```json
{
  "sql.js": "^1.10.0"
}
```

---

## Decisions Made

| Question | Decision |
|----------|----------|
| Image Storage | Store full base64 in SQLite |
| Gallery Location | Sidebar on left with thumbnails; clicking a run replaces main view |
| History Limits | Unlimited (user manages manually with delete) |
| Failed Runs | No, only save successful runs |
| Search/Filter | Not for v1 |
| Export/Import | Not for v1 |
| Comment Visibility | Both (metrics panel after generation + history detail view) |

## UI Flow

1. **Left sidebar** shows thumbnail gallery of past runs
2. **Clicking a thumbnail** replaces the main editor with that run's detail view
3. **"Localize title" button** creates a new run and saves it to history
4. **Comment field** appears in metrics panel after generation AND in history detail
5. **Delete button** in history detail view removes run from database

---

## Estimated Implementation Order

1. ✅ Create plan (this document)
2. ✅ Database setup with sql.js (hybrid: SQLite for metadata, IndexedDB for images)
3. ✅ Data layer (CRUD operations)
4. ✅ Auto-save on generation
5. ✅ Basic gallery view (sidebar with thumbnails)
6. ✅ Run detail view
7. ✅ Comment editing (both in metrics panel and detail view)
8. ✅ Delete functionality
9. ⬜ "Load from history" feature (optional - can restore settings to editor)
10. ⬜ Polish & testing
