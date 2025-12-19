import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Globe,
  Image as ImageIcon,
  Upload,
  Wand2,
} from "lucide-react";
import { useDebugLog } from "./lib/useDebugLog";
import {
  formatCost,
  formatDuration,
  generateCover,
  type RunMetrics,
} from "./lib/coverGeneration";
import {
  fetchImageEditModels,
  type ImageEditModel,
} from "./lib/openRouterModels";
import useLocalStorageState from "use-local-storage-state";

const DEFAULT_PROMPT_TEMPLATE = `Edit this children's book cover image.

Task:
- Replace ONLY the main title text with: "{{NEW_TITLE}}".

Constraints:
- Preserve the original font style, curvature/warp, size, color, texture, and position.
- Seamlessly remove the old title and inpaint the background behind it.
- Do not change any other text or artwork.

Output:
- Return ONLY the edited image.`;

function compilePrompt(promptTemplate: string, newTitleValue: string) {
  const title = newTitleValue.trim();
  const replaced = promptTemplate.replaceAll("{{NEW_TITLE}}", title);
  // If the user removed the placeholder, keep the app functional by appending the title instruction.
  if (!promptTemplate.includes("{{NEW_TITLE}}")) {
    return `${replaced}\n\nReplace the main title with: "${title}".`;
  }
  return replaced;
}

export default function BookCoverLocalizer() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const {
    logEvent,
    copyLogToClipboard,
    copySuccess: logCopySuccess,
  } = useDebugLog();
  const logEventRef = useRef(logEvent);
  useEffect(() => {
    logEventRef.current = logEvent;
  }, [logEvent]);

  const [apiKeyOpenRouter, setApiKeyOpenRouter] = useLocalStorageState(
    "coverLocalizer.apiKeyOpenRouter",
    { defaultValue: "" }
  );
  const [inputImage, setInputImage] = useLocalStorageState<string | null>(
    "coverLocalizer.inputImage",
    { defaultValue: null }
  );
  const [outputImage, setOutputImage] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useLocalStorageState(
    "coverLocalizer.newTitle",
    {
      defaultValue: "",
    }
  );
  const [models, setModels] = useLocalStorageState<ImageEditModel[]>(
    "coverLocalizer.models",
    { defaultValue: [] }
  );
  const [modelsLoading, setModelsLoading] = useState(models.length === 0);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useLocalStorageState(
    "coverLocalizer.selectedModel",
    { defaultValue: "" }
  );
  const [promptTemplate, setPromptTemplate] = useLocalStorageState(
    "coverLocalizer.promptTemplate",
    { defaultValue: DEFAULT_PROMPT_TEMPLATE }
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");
  const [copySuccess, setCopySuccess] = useState(false);
  const [lastRun, setLastRun] = useState<RunMetrics | null>(null);

  const selectedModelLabel = useMemo(() => {
    return models.find((m) => m.id === selectedModel)?.label ?? selectedModel;
  }, [models, selectedModel]);

  useEffect(() => {
    logEvent("app.start", { details: { userAgent: navigator.userAgent } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logEvent("state.snapshot", {
      provider: "openrouter",
      model: selectedModel,
      details: {
        openRouterKeyLength: apiKeyOpenRouter.trim().length,
        titleChars: newTitle.trim().length,
        promptChars: promptTemplate.length,
        hasPlaceholder: promptTemplate.includes("{{NEW_TITLE}}"),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [modelsReloadToken, setModelsReloadToken] = useState(0);

  const reloadModels = useCallback(() => {
    setModelsReloadToken((token) => token + 1);
    logEventRef.current("models.reload", { provider: "openrouter" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);

    (async () => {
      setModelsLoading(true);
      setModelsError(null);
      try {
        const list = await fetchImageEditModels({ signal: controller.signal });
        if (cancelled) return;
        setModels(list);
        logEventRef.current("models.loaded", {
          provider: "openrouter",
          details: { count: list.length },
        });

        setSelectedModel((prev) => {
          const keep = prev && list.some((m) => m.id === prev);
          return keep ? prev : list[0]?.id ?? prev;
        });
      } catch (err) {
        if (cancelled) return;
        const message =
          err && typeof err === "object" && "name" in err && err.name === "AbortError"
            ? "Timed out while loading OpenRouter model list."
            : String((err as any)?.message ?? err);
        setModelsError(message);
        logEventRef.current("models.error", {
          provider: "openrouter",
          details: { message },
        });
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [modelsReloadToken]);

  useEffect(() => {
    if (models.length === 0) return;
    setSelectedModel((prev) => {
      const keep = prev && models.some((m) => m.id === prev);
      return keep ? prev : models[0]?.id ?? prev;
    });
  }, [models, setSelectedModel]);

  // Global paste: image -> input image
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.includes("image")) {
          const blob = item.getAsFile();
          if (!blob) continue;
          logEvent("input.paste_image", {
            details: { mimeType: blob.type || "unknown", bytes: blob.size },
          });
          const reader = new FileReader();
          reader.onload = (event) => {
            const result = event.target?.result;
            if (typeof result === "string") {
              setInputImage(result);
              setOutputImage(null);
              setError("");
            }
          };
          reader.readAsDataURL(blob);
          break;
        }
      }
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    logEvent("input.upload", {
      details: {
        name: file.name,
        mimeType: file.type || "unknown",
        bytes: file.size,
      },
    });

    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result;
      if (typeof result === "string") {
        setInputImage(result);
        setOutputImage(null);
        setError("");
      }
    };
    reader.readAsDataURL(file);
  };

  const copyToClipboard = async () => {
    if (!outputImage) return;

    try {
      const response = await fetch(outputImage);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob,
        }),
      ]);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 1500);
      logEvent("output.copy_image.success", {
        details: { mimeType: blob.type || "unknown", bytes: blob.size },
      });
    } catch (err) {
      console.error(err);
      setError("Failed to copy image to clipboard.");
      logEvent("output.copy_image.error", {
        details: { message: String(err) },
      });
    }
  };

  const generate = async () => {
    if (!inputImage) {
      setError("Paste or upload an input image first.");
      return;
    }
    if (!newTitle.trim()) {
      setError("Enter the new title text.");
      return;
    }

    if (!apiKeyOpenRouter.trim()) {
      setError("Enter an OpenRouter API key.");
      return;
    }

    if (!selectedModel.trim()) {
      setError("Select an OpenRouter image model.");
      return;
    }

    setIsGenerating(true);
    setError("");

    const prompt = compilePrompt(promptTemplate, newTitle);

    logEvent("generate.start", {
      provider: "openrouter",
      model: selectedModel,
      details: {
        titleChars: newTitle.trim().length,
        promptChars: prompt.length,
      },
    });

    try {
      const result = await generateCover({
        model: selectedModel,
        prompt,
        inputDataUrl: inputImage,
        apiKeyOpenRouter,
        logEvent,
      });

      setOutputImage(result.imageUrl);
      setLastRun(result.metrics);

      logEvent("generate.success", {
        provider: "openrouter",
        model: selectedModel,
        details: {
          metrics: result.metrics,
          outputKind: result.imageUrl.startsWith("data:")
            ? "dataUrl"
            : result.imageUrl.startsWith("http")
            ? "httpUrl"
            : "other",
          outputChars: result.imageUrl.length,
        },
      });
    } catch (err: any) {
      console.error(err);
      setError(`Generation failed: ${err?.message ?? "Unknown error"}`);
      logEvent("generate.error", {
        provider: "openrouter",
        model: selectedModel,
        details: { message: String(err?.message ?? err) },
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans flex flex-col">
      <header className="bg-slate-900 border-b border-slate-800 p-4 flex flex-col md:flex-row items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-600 rounded-lg">
            <ImageIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">CoverLocalizer</h1>
            <p className="text-xs text-slate-400">
              Paste/upload input → generate output → copy
            </p>
          </div>
        </div>

        <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2 w-full md:w-auto">
          <div className="flex items-center bg-slate-950 rounded-md border border-slate-800 px-3 py-2 w-full md:w-80 focus-within:border-indigo-500">
            <Globe className="w-4 h-4 text-emerald-400 mr-2" />
            <input
              type="password"
              placeholder="OpenRouter API key"
              value={apiKeyOpenRouter}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setApiKeyOpenRouter(e.target.value)
              }
              onBlur={() =>
                logEvent("apikey.blur", {
                  provider: "openrouter",
                  model: selectedModel,
                  details: {
                    keyLength: apiKeyOpenRouter.trim().length,
                  },
                })
              }
              className="bg-transparent border-none outline-none text-sm text-slate-200 w-full placeholder-slate-600"
            />
          </div>

          <div className="flex flex-col w-full md:w-auto">
            <div className="flex flex-row gap-2">
              <select
                value={selectedModel}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                  const next = e.target.value;
                  setSelectedModel(next);
                  logEvent("model.change", {
                    provider: "openrouter",
                    model: next,
                  });
                }}
                className="flex-1 bg-slate-800 border border-slate-700 text-sm rounded-md px-3 py-2 text-slate-200 outline-none"
                disabled={modelsLoading && models.length === 0}
              >
                {modelsLoading ? (
                  <option value="">Loading models…</option>
                ) : models.length === 0 ? (
                  <option value="">No image-edit models found</option>
                ) : (
                  models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>

              <button
                type="button"
                onClick={reloadModels}
                disabled={modelsLoading}
                className="px-3 py-2 rounded-md border border-slate-700 bg-slate-800 text-slate-200 text-sm whitespace-nowrap disabled:opacity-50"
                title="Reload model list"
              >
                {modelsLoading ? "Loading…" : "Reload"}
              </button>
            </div>
            {modelsError && (
              <div className="text-xs text-amber-300 mt-1">
                Failed to load model list. Please retry.
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={async () => {
              try {
                await copyLogToClipboard();
              } catch (err) {
                console.error(err);
                setError("Failed to copy log to clipboard.");
                logEvent("debug.copy_log.error", {
                  details: { message: String(err) },
                });
              }
            }}
            className="text-sm px-3 py-2 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
            title="Copy debug log (no image bytes)"
          >
            {logCopySuccess ? (
              <span className="inline-flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-400" /> Copied log
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Copy className="w-4 h-4" /> Copy log
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-0">
        <section className="p-4 md:p-6">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Input */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                <div className="text-sm font-semibold">Input image</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Upload className="w-3.5 h-3.5" /> Upload
                    </span>
                  </button>
                </div>

                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept="image/*"
                  onChange={handleFileUpload}
                />
              </div>

              <div className="p-4">
                {!inputImage ? (
                  <div className="border-2 border-dashed border-slate-700 rounded-xl p-10 text-slate-400 text-sm">
                    <div className="flex items-center gap-2 font-medium text-slate-300 mb-2">
                      <Upload className="w-4 h-4" /> Paste (Ctrl+V) or upload
                    </div>
                    <div className="text-slate-500">
                      Tip: click anywhere then paste a screenshot.
                    </div>
                  </div>
                ) : (
                  <img
                    src={inputImage}
                    alt="Input"
                    className="w-full max-h-[70vh] object-contain rounded-xl border border-slate-800 bg-slate-950"
                  />
                )}
              </div>
            </div>

            {/* Output */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden relative">
              <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                <div className="text-sm font-semibold">Output image</div>
                <div className="flex items-center gap-2">
                  {outputImage && (
                    <>
                      <button
                        onClick={copyToClipboard}
                        className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700"
                      >
                        <span className="inline-flex items-center gap-1">
                          {copySuccess ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" />{" "}
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" /> Copy
                            </>
                          )}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="p-4">
                {!outputImage ? (
                  <div className="border-2 border-dashed border-slate-700 rounded-xl p-10 text-slate-500 text-sm">
                    Output will appear here.
                  </div>
                ) : (
                  <img
                    src={outputImage}
                    alt="Output"
                    className="w-full max-h-[70vh] object-contain rounded-xl border border-slate-800 bg-slate-950"
                  />
                )}
              </div>

              {isGenerating && (
                <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex flex-col items-center justify-center">
                  <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4" />
                  <div className="text-indigo-200 text-sm font-medium">
                    Generating…
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <aside className="bg-slate-900 border-t lg:border-t-0 lg:border-l border-slate-800 p-4 md:p-6 flex flex-col">
          <div className="space-y-3 flex-1">
            <div className="text-sm font-medium text-slate-300">New Title</div>
            <textarea
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onBlur={() =>
                logEvent("title.blur", {
                  provider: "openrouter",
                  model: selectedModel,
                  details: { titleChars: newTitle.trim().length },
                })
              }
              placeholder="e.g. The Little Robot That Could"
              className="w-full h-40 bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 outline-none resize-none focus:ring-2 focus:ring-indigo-500"
            />

            <div className="flex items-center justify-between pt-2">
              <div>
                <div className="text-sm font-medium text-slate-300">Prompt</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPromptTemplate(DEFAULT_PROMPT_TEMPLATE);
                  logEvent("prompt.restore_default");
                }}
                className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                title="Restore default prompt"
              >
                Reset
              </button>
            </div>

            <textarea
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              onBlur={() =>
                logEvent("prompt.blur", {
                  provider: "openrouter",
                  model: selectedModel,
                  details: {
                    promptChars: promptTemplate.length,
                    hasPlaceholder: promptTemplate.includes("{{NEW_TITLE}}"),
                  },
                })
              }
              className="w-full h-44 bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 outline-none resize-none focus:ring-2 focus:ring-indigo-500 font-mono text-xs"
            />

            {modelsError && (
              <div className="p-3 bg-amber-900/20 border border-amber-800/40 rounded-xl text-amber-200 text-sm">
                Failed to load model list. You can still try if a
                previously-selected model is saved.
                <button
                  type="button"
                  onClick={reloadModels}
                  className="mt-2 inline-flex items-center gap-1 text-amber-100 underline-offset-2 hover:underline"
                >
                  Retry now
                </button>
                <div className="text-xs text-amber-300/80 mt-1 break-words">
                  {modelsError}
                </div>
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-900/30 border border-red-800/40 rounded-xl flex items-start text-red-200 text-sm">
                <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}

            <button
              onClick={generate}
              disabled={isGenerating || !inputImage}
              className={`w-full py-3.5 px-4 rounded-xl flex items-center justify-center font-semibold text-white transition-all active:scale-[0.99]
                ${
                  isGenerating || !inputImage
                    ? "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700"
                    : "bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500"
                }`}
            >
              <Wand2
                className={`w-5 h-5 mr-2 ${isGenerating ? "animate-spin" : ""}`}
              />
              {isGenerating ? "Generating…" : "Localize title"}
            </button>

            {lastRun && !isGenerating && (
              <div className="mt-2 p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300 space-y-1">
                <div>
                  <span className="text-slate-100">openrouter</span>
                  {lastRun.servedBy && (
                    <span className="text-slate-100">
                      {" "}
                      — {lastRun.servedBy}
                    </span>
                  )}
                </div>
                {selectedModelLabel && (
                  <div>
                    Model:{" "}
                    <span className="text-slate-100">{selectedModelLabel}</span>
                  </div>
                )}
                {lastRun.route && (
                  <div>
                    Route:{" "}
                    <span className="text-slate-100">{lastRun.route}</span>
                  </div>
                )}
                {(lastRun.promptTokens != null ||
                  lastRun.completionTokens != null ||
                  lastRun.totalTokens != null) && (
                  <div>
                    Tokens:{" "}
                    <span className="text-slate-100">
                      in {lastRun.promptTokens ?? "—"} / out{" "}
                      {lastRun.completionTokens ?? "—"} / total{" "}
                      {lastRun.totalTokens ?? "—"}
                    </span>
                  </div>
                )}
                {lastRun.cost != null && (
                  <div>
                    Cost:{" "}
                    <span className="text-slate-100">
                      {lastRun.formattedCost ?? formatCost(lastRun.cost)}
                    </span>
                  </div>
                )}
                {lastRun.durationMs != null && (
                  <div>
                    Duration:{" "}
                    <span className="text-slate-100">
                      {formatDuration(lastRun.durationMs)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
