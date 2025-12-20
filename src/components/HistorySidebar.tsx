import { useEffect, useState } from "react";
import { Clock, Trash2, X } from "lucide-react";
import { getRuns, loadImage, deleteRun, type RunRecord } from "../lib/db";
import { formatCost, formatDuration } from "../lib/coverGeneration";

interface HistorySidebarProps {
  selectedRunId: number | null;
  onSelectRun: (run: RunRecord | null) => void;
  refreshToken: number; // Increment to trigger refresh
}

interface ThumbnailCache {
  [imageId: string]: string;
}

export default function HistorySidebar({
  selectedRunId,
  onSelectRun,
  refreshToken,
}: HistorySidebarProps) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [thumbnails, setThumbnails] = useState<ThumbnailCache>({});
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  // Load runs from database
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await getRuns();
        if (!cancelled) {
          setRuns(data);
        }
      } catch (err) {
        console.error("Failed to load runs:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Load thumbnails lazily
  useEffect(() => {
    runs.forEach((run) => {
      if (!thumbnails[run.outputImageId]) {
        loadImage(run.outputImageId).then((img) => {
          if (img) {
            setThumbnails((prev) => ({ ...prev, [run.outputImageId]: img }));
          }
        });
      }
    });
  }, [runs, thumbnails]);

  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleteConfirm === id) {
      try {
        await deleteRun(id);
        setRuns((prev) => prev.filter((r) => r.id !== id));
        if (selectedRunId === id) {
          onSelectRun(null);
        }
      } catch (err) {
        console.error("Failed to delete run:", err);
      }
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(id);
      // Auto-cancel after 3 seconds
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  };

  // Clean model label: "openai/gpt-5-image-mini — GPT-5 Image Mini" -> "GPT-5 Image Mini"
  const cleanModelLabel = (label: string) => {
    const dashIndex = label.indexOf(" — ");
    if (dashIndex !== -1) {
      return label.slice(dashIndex + 3);
    }
    const slashIndex = label.lastIndexOf("/");
    if (slashIndex !== -1) {
      return label.slice(slashIndex + 1).replace(/-/g, " ");
    }
    return label;
  };

  return (
    <aside className="w-48 bg-slate-900 border-r border-slate-800 flex flex-col h-full shrink-0 overflow-hidden">
      <div className="p-2 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <Clock className="w-3 h-3" />
          History
        </div>
        {selectedRunId && (
          <button
            onClick={() => onSelectRun(null)}
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            title="Back to editor"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 space-y-1.5">
        {loading ? (
          <div className="text-slate-500 text-xs text-center py-4">
            Loading…
          </div>
        ) : runs.length === 0 ? (
          <div className="text-slate-500 text-xs text-center py-4"></div>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              onClick={() => onSelectRun(run)}
              className={`rounded-lg border cursor-pointer transition-all ${
                selectedRunId === run.id
                  ? "border-indigo-500 bg-indigo-950/30"
                  : "border-slate-800 bg-slate-950 hover:border-slate-700"
              }`}
            >
              {/* Thumbnail */}
              <div className="aspect-[4/3] bg-slate-800 rounded-t-lg overflow-hidden">
                {thumbnails[run.outputImageId] ? (
                  <img
                    src={thumbnails[run.outputImageId]}
                    alt="Output"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-600">
                    <Clock className="w-4 h-4 animate-pulse" />
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-1.5 space-y-0.5">
                <div className="text-xs text-slate-200 font-medium truncate">
                  {cleanModelLabel(run.modelLabel)}
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-500">
                  <span>
                    {run.durationMs != null
                      ? formatDuration(run.durationMs)
                      : "—"}
                  </span>
                  {run.cost != null && <span>{formatCost(run.cost)}</span>}
                </div>
                {run.humanComment && (
                  <div className="text-[10px] text-slate-400 italic truncate">
                    "{run.humanComment}"
                  </div>
                )}

                {/* Delete button - only show on selected */}
                {selectedRunId === run.id && (
                  <button
                    onClick={(e) => handleDelete(run.id, e)}
                    className={`mt-0.5 p-1 rounded flex items-center justify-center transition-colors ${
                      deleteConfirm === run.id
                        ? "bg-red-600 text-white"
                        : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                    }`}
                    title={
                      deleteConfirm === run.id ? "Click to confirm" : "Delete"
                    }
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
