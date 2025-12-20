import initSqlJs, { Database } from "sql.js";

// Types
export interface RunRecord {
  id: number;
  createdAt: string;
  modelId: string;
  modelLabel: string;
  promptTemplate: string;
  compiledPrompt: string;
  newTitle: string;
  inputImageId: string; // Reference to IndexedDB
  outputImageId: string; // Reference to IndexedDB
  servedBy: string | null;
  route: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  durationMs: number | null;
  humanComment: string | null;
}

// Extended type with loaded images
export interface RunRecordWithImages extends RunRecord {
  inputImage: string;
  outputImage: string;
}

export interface RunInsert {
  createdAt: string;
  modelId: string;
  modelLabel: string;
  promptTemplate: string;
  compiledPrompt: string;
  newTitle: string;
  inputImage: string; // Actual base64 data
  outputImage: string; // Actual base64 data
  servedBy: string | null;
  route: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  durationMs: number | null;
  humanComment: string | null;
}

// Database singleton
let db: Database | null = null;
let dbInitPromise: Promise<Database> | null = null;

const DB_KEY = "coverLocalizer.sqlite";
const IDB_NAME = "CoverLocalizerDB";
const IDB_VERSION = 2;

// ============ IndexedDB Helpers ============

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const idb = request.result;
      if (!idb.objectStoreNames.contains("sqlite")) {
        idb.createObjectStore("sqlite");
      }
      if (!idb.objectStoreNames.contains("images")) {
        idb.createObjectStore("images");
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

// Generate a simple hash for content-based deduplication
async function hashImage(data: string): Promise<string> {
  // Use SubtleCrypto for a fast SHA-256 hash
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `img_${hashHex.slice(0, 16)}`; // Use first 16 chars for reasonable uniqueness
}

// Check if an image exists in IndexedDB
async function imageExists(imageId: string): Promise<boolean> {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("images", "readonly");
    const store = tx.objectStore("images");
    const getReq = store.get(imageId);
    getReq.onsuccess = () => {
      idb.close();
      resolve(getReq.result !== undefined);
    };
    getReq.onerror = () => {
      idb.close();
      reject(getReq.error);
    };
  });
}

// Save an image to IndexedDB (with deduplication)
// Returns the image ID (content-hash based for inputs, random for outputs)
async function saveImageDeduped(
  data: string,
  forceNew = false
): Promise<string> {
  const imageId = forceNew
    ? `img_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    : await hashImage(data);

  // Check if already exists (skip for forceNew)
  if (!forceNew) {
    const exists = await imageExists(imageId);
    if (exists) {
      return imageId; // Reuse existing image
    }
  }

  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("images", "readwrite");
    const store = tx.objectStore("images");
    store.put(data, imageId);
    tx.oncomplete = () => {
      idb.close();
      resolve(imageId);
    };
    tx.onerror = () => {
      idb.close();
      reject(tx.error);
    };
  });
}

// Load an image from IndexedDB
export async function loadImage(imageId: string): Promise<string | null> {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("images", "readonly");
    const store = tx.objectStore("images");
    const getReq = store.get(imageId);
    getReq.onsuccess = () => {
      idb.close();
      resolve(getReq.result ?? null);
    };
    getReq.onerror = () => {
      idb.close();
      reject(getReq.error);
    };
  });
}

// Delete an image from IndexedDB
async function deleteImage(imageId: string): Promise<void> {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("images", "readwrite");
    const store = tx.objectStore("images");
    store.delete(imageId);
    tx.oncomplete = () => {
      idb.close();
      resolve();
    };
    tx.onerror = () => {
      idb.close();
      reject(tx.error);
    };
  });
}

// ============ SQLite Persistence ============

async function saveToIndexedDB(data: Uint8Array): Promise<void> {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("sqlite", "readwrite");
    const store = tx.objectStore("sqlite");
    store.put(data, DB_KEY);
    tx.oncomplete = () => {
      idb.close();
      resolve();
    };
    tx.onerror = () => {
      idb.close();
      reject(tx.error);
    };
  });
}

async function loadFromIndexedDB(): Promise<Uint8Array | null> {
  const idb = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction("sqlite", "readonly");
    const store = tx.objectStore("sqlite");
    const getReq = store.get(DB_KEY);
    getReq.onsuccess = () => {
      idb.close();
      resolve(getReq.result ?? null);
    };
    getReq.onerror = () => {
      idb.close();
      reject(getReq.error);
    };
  });
}

// ============ Database Init ============

export async function initDatabase(): Promise<Database> {
  if (db) return db;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    const SQL = await initSqlJs({
      locateFile: (file: string) => `https://sql.js.org/dist/${file}`,
    });

    const existingData = await loadFromIndexedDB();
    if (existingData) {
      db = new SQL.Database(existingData);
    } else {
      db = new SQL.Database();
    }

    // Create table with image IDs instead of image data
    db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_label TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        compiled_prompt TEXT NOT NULL,
        new_title TEXT NOT NULL,
        input_image_id TEXT NOT NULL,
        output_image_id TEXT NOT NULL,
        served_by TEXT,
        route TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cost REAL,
        duration_ms INTEGER,
        human_comment TEXT
      )
    `);

    await persistDatabase();
    return db;
  })();

  return dbInitPromise;
}

export async function persistDatabase(): Promise<void> {
  if (!db) return;
  const data = db.export();
  await saveToIndexedDB(data);
}

// ============ CRUD Operations ============

export async function saveRun(run: RunInsert): Promise<number> {
  const database = await initDatabase();

  // Input images: deduplicated (same image = same hash = reused)
  // Output images: always unique (forceNew = true)
  const [inputImageId, outputImageId] = await Promise.all([
    saveImageDeduped(run.inputImage, false), // Deduplicate inputs
    saveImageDeduped(run.outputImage, true), // Always new for outputs
  ]);

  // Save metadata to SQLite
  database.run(
    `INSERT INTO runs (
      created_at, model_id, model_label, prompt_template, compiled_prompt,
      new_title, input_image_id, output_image_id, served_by, route,
      prompt_tokens, completion_tokens, total_tokens, cost, duration_ms, human_comment
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.createdAt,
      run.modelId,
      run.modelLabel,
      run.promptTemplate,
      run.compiledPrompt,
      run.newTitle,
      inputImageId,
      outputImageId,
      run.servedBy,
      run.route,
      run.promptTokens,
      run.completionTokens,
      run.totalTokens,
      run.cost,
      run.durationMs,
      run.humanComment,
    ]
  );

  const result = database.exec("SELECT last_insert_rowid() as id");
  const id = result[0]?.values[0]?.[0] as number;

  await persistDatabase();
  return id;
}

// Get all runs metadata (without images - fast!)
export async function getRuns(): Promise<RunRecord[]> {
  const database = await initDatabase();

  const result = database.exec(`
    SELECT id, created_at, model_id, model_label, prompt_template, compiled_prompt,
           new_title, input_image_id, output_image_id, served_by, route,
           prompt_tokens, completion_tokens, total_tokens, cost, duration_ms, human_comment
    FROM runs
    ORDER BY created_at DESC
  `);

  if (!result[0]) return [];

  return result[0].values.map((row: unknown[]) => ({
    id: row[0] as number,
    createdAt: row[1] as string,
    modelId: row[2] as string,
    modelLabel: row[3] as string,
    promptTemplate: row[4] as string,
    compiledPrompt: row[5] as string,
    newTitle: row[6] as string,
    inputImageId: row[7] as string,
    outputImageId: row[8] as string,
    servedBy: row[9] as string | null,
    route: row[10] as string | null,
    promptTokens: row[11] as number | null,
    completionTokens: row[12] as number | null,
    totalTokens: row[13] as number | null,
    cost: row[14] as number | null,
    durationMs: row[15] as number | null,
    humanComment: row[16] as string | null,
  }));
}

// Get a single run by ID (metadata only)
export async function getRunById(id: number): Promise<RunRecord | null> {
  const database = await initDatabase();

  const stmt = database.prepare(`
    SELECT id, created_at, model_id, model_label, prompt_template, compiled_prompt,
           new_title, input_image_id, output_image_id, served_by, route,
           prompt_tokens, completion_tokens, total_tokens, cost, duration_ms, human_comment
    FROM runs
    WHERE id = ?
  `);
  stmt.bind([id]);

  if (!stmt.step()) {
    stmt.free();
    return null;
  }

  const row = stmt.get();
  stmt.free();
  return {
    id: row[0] as number,
    createdAt: row[1] as string,
    modelId: row[2] as string,
    modelLabel: row[3] as string,
    promptTemplate: row[4] as string,
    compiledPrompt: row[5] as string,
    newTitle: row[6] as string,
    inputImageId: row[7] as string,
    outputImageId: row[8] as string,
    servedBy: row[9] as string | null,
    route: row[10] as string | null,
    promptTokens: row[11] as number | null,
    completionTokens: row[12] as number | null,
    totalTokens: row[13] as number | null,
    cost: row[14] as number | null,
    durationMs: row[15] as number | null,
    humanComment: row[16] as string | null,
  };
}

// Get a run with its images loaded
export async function getRunWithImages(
  id: number
): Promise<RunRecordWithImages | null> {
  const run = await getRunById(id);
  if (!run) return null;

  const [inputImage, outputImage] = await Promise.all([
    loadImage(run.inputImageId),
    loadImage(run.outputImageId),
  ]);

  return {
    ...run,
    inputImage: inputImage ?? "",
    outputImage: outputImage ?? "",
  };
}

// Load images for a run record
export async function loadImagesForRun(
  run: RunRecord
): Promise<{ inputImage: string; outputImage: string }> {
  const [inputImage, outputImage] = await Promise.all([
    loadImage(run.inputImageId),
    loadImage(run.outputImageId),
  ]);
  return {
    inputImage: inputImage ?? "",
    outputImage: outputImage ?? "",
  };
}

// Update a run's comment
export async function updateRunComment(
  id: number,
  comment: string
): Promise<void> {
  const database = await initDatabase();
  database.run("UPDATE runs SET human_comment = ? WHERE id = ?", [comment, id]);
  await persistDatabase();
}

// Delete a run (and its images, with reference counting for shared inputs)
export async function deleteRun(id: number): Promise<void> {
  const run = await getRunById(id);
  if (!run) return;

  const database = await initDatabase();

  // Check if the input image is used by other runs
  const stmt = database.prepare(
    "SELECT COUNT(*) as count FROM runs WHERE input_image_id = ? AND id != ?"
  );
  stmt.bind([run.inputImageId, id]);
  stmt.step();
  const countRow = stmt.get();
  stmt.free();
  const inputUsageCount = (countRow?.[0] as number) ?? 0;

  // Delete metadata from SQLite first
  database.run("DELETE FROM runs WHERE id = ?", [id]);
  await persistDatabase();

  // Delete images from IndexedDB
  // Only delete input image if no other runs reference it
  const deletePromises: Promise<void>[] = [deleteImage(run.outputImageId)];
  if (inputUsageCount === 0) {
    deletePromises.push(deleteImage(run.inputImageId));
  }

  await Promise.all(deletePromises);
}

// ============ Sample Data Seeding ============

// Helper to convert an image URL to a data URL
async function fetchImageAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Seed the database with a sample run if it's empty
export async function seedSampleDataIfEmpty(): Promise<boolean> {
  const runs = await getRuns();
  if (runs.length > 0) {
    return false; // Already has data, don't seed
  }

  try {
    // Fetch the sample images from the sample directory
    // Use import.meta.env.BASE_URL to handle GitHub Pages base path
    const base = import.meta.env.BASE_URL;
    const [inputImage, outputImage] = await Promise.all([
      fetchImageAsDataUrl(`${base}sample/input.png`),
      fetchImageAsDataUrl(`${base}sample/output.jpg`),
    ]);

    // Create a sample run record
    const sampleRun: RunInsert = {
      createdAt: new Date().toISOString(),
      modelId: "google/gemini-3-pro-image-preview",
      modelLabel:
        "google/gemini-3-pro-image-preview — Gemini 3 Pro Image Preview",
      promptTemplate: "",
      compiledPrompt: "This is a sample to show what the app can do.",
      newTitle: "Khu vườn bí mật",
      inputImage,
      outputImage,
      servedBy: null,
      route: null,
      promptTokens: 368,
      completionTokens: 1443,
      totalTokens: 1811,
      cost: 0.138,
      durationMs: 19000,
      humanComment:
        "I made this sample with vietnamese, using a low-res input.",
    };

    await saveRun(sampleRun);
    return true; // Seeded successfully
  } catch (err) {
    console.error("Failed to seed sample data:", err);
    return false;
  }
}
