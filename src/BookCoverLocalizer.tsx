import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  // Globe, // Commented out - was used for API key input
  Image as ImageIcon,
  MessageSquare,
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
import {
  initDatabase,
  saveRun,
  updateRunComment,
  loadImagesForRun,
  seedSampleDataIfEmpty,
  type RunRecord,
  type RunInsert,
} from "./lib/db";
import useLocalStorageState from "use-local-storage-state";
import Select from "react-select";
import HistorySidebar from "./components/HistorySidebar";
import MagnifiableImage from "./components/MagnifiableImage";
import { initiateOAuthFlow, handleOAuthCallback } from "./lib/openRouterOAuth";

const MATCH_TEXT_MAIN_TITLE = "<main title>";

const DEFAULT_PROMPT_TEMPLATE = `Edit this image.

Task:
- Find and replace ONLY {{MATCH_TEXT}} with: "{{REPLACEMENT_TEXT}}".

Constraints:
- Preserve the original font style, curvature/warp, size, color, texture, and position.
- Seamlessly remove the old text and inpaint the background behind it.
- Do not change any other text or artwork.
- The output image MUST have the exact same dimensions (width and height) as the input image.

Output:
- Return ONLY the edited image.`;

// Model metadata for recommendations/warnings
interface ModelMeta {
  recommended?: boolean;
  hidden?: boolean;
  subtitle?: string;
}

const MODEL_META: Record<string, ModelMeta> = {
  "google/gemini-3-pro-image-preview": {
    recommended: true,
    subtitle: "Recommended",
  },
  "google/gemini-2.5-flash-image": {
    subtitle: "Unreliable text replacement",
  },
  "google/gemini-2.5-flash-image-preview": {
    hidden: true,
  },
  "openai/gpt-5-image": {
    subtitle: "Does not preserve image exactly",
  },
  "openai/gpt-5-image-mini": {
    subtitle: "Does not preserve image exactly",
  },
};

// Default to the recommended model
const DEFAULT_RECOMMENDED_MODEL = "google/gemini-3-pro-image-preview";

// Extract file extension from image data URL or URL
function getImageExtension(src: string): string {
  if (src.startsWith("data:image/")) {
    const match = src.match(/^data:image\/(\w+)/);
    if (match) {
      const format = match[1].toLowerCase();
      // Normalize common formats
      if (format === "jpeg") return "jpg";
      return format;
    }
  }
  // For HTTP URLs, try to get extension from path
  if (src.startsWith("http")) {
    const url = new URL(src);
    const ext = url.pathname.split(".").pop()?.toLowerCase();
    if (ext && ["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  return "png"; // fallback
}

function compilePrompt(
  promptTemplate: string,
  matchText: string,
  replacementText: string
) {
  const replacement = replacementText.trim();
  const isMainTitle = matchText === MATCH_TEXT_MAIN_TITLE;
  const matchDisplay = isMainTitle
    ? "the main title text"
    : `"${matchText.trim()}"`;

  // Check if the template has placeholders
  const hasMatchPlaceholder = promptTemplate.includes("{{MATCH_TEXT}}");
  const hasReplacementPlaceholder = promptTemplate.includes(
    "{{REPLACEMENT_TEXT}}"
  );

  // If the template has placeholders, replace them
  let compiled = promptTemplate
    .replaceAll("{{MATCH_TEXT}}", matchDisplay)
    .replaceAll("{{REPLACEMENT_TEXT}}", replacement);

  // ONLY append instruction if the DEFAULT template is being used (has both placeholders)
  // If user has edited the prompt to remove placeholders, respect that
  if (hasMatchPlaceholder && hasReplacementPlaceholder) {
    // Template has placeholders, they were replaced, no need to append
    return compiled;
  } else if (!hasMatchPlaceholder && !hasReplacementPlaceholder) {
    // User has customized the prompt completely - send as-is without modification
    return compiled;
  } else {
    // Only one placeholder present (edge case) - append instruction for safety
    compiled += `\n\nFind and replace ${matchDisplay} with: "${replacement}".`;
    return compiled;
  }
}

export default function BookCoverLocalizer() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { logEvent } = useDebugLog();
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
  const [matchText, setMatchText] = useLocalStorageState(
    "imageLocalizer.matchText",
    { defaultValue: MATCH_TEXT_MAIN_TITLE }
  );
  const [replacementText, setReplacementText] = useLocalStorageState(
    "imageLocalizer.replacementText",
    { defaultValue: "" }
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
  const [inputCopySuccess, setInputCopySuccess] = useState(false);
  const [lastRun, setLastRun] = useState<RunMetrics | null>(null);
  const [lastRunId, setLastRunId] = useState<number | null>(null);
  const [lastRunComment, setLastRunComment] = useState("");

  // History state
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [dbReady, setDbReady] = useState(false);

  // State for viewing a history run's images
  const [viewingHistoryImages, setViewingHistoryImages] = useState<{
    input: string;
    output: string;
    runComment: string;
  } | null>(null);
  const [historyComment, setHistoryComment] = useState("");

  // Track input image dimensions for comparison with output
  const [inputDimensions, setInputDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  // State for OAuth flow
  const [oauthLoading, setOauthLoading] = useState(false);

  // Generation timer state
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Debug: simulate OpenRouter errors (set localStorage "debug.simulateError" to "credits", "unavailable", or "timeout")
  const simulateError =
    typeof window !== "undefined"
      ? localStorage.getItem("debug.simulateError")
      : null;

  // Handle OAuth callback on mount
  useEffect(() => {
    handleOAuthCallback()
      .then((key) => {
        if (key) {
          setApiKeyOpenRouter(key);
          logEvent("oauth.success", { details: { keyLength: key.length } });
        }
      })
      .catch((err) => {
        console.error("OAuth callback error:", err);
        logEvent("oauth.error", { details: { message: String(err) } });
        setError(`OAuth failed: ${err?.message ?? "Unknown error"}`);
      });
  }, []);

  // Generation timer effect
  useEffect(() => {
    if (!isGenerating) {
      setElapsedSeconds(0);
      return;
    }

    const startTime = Date.now();
    setElapsedSeconds(0);

    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [isGenerating]);

  // Initialize database on mount and seed sample data if empty
  useEffect(() => {
    initDatabase()
      .then(async () => {
        const seeded = await seedSampleDataIfEmpty();
        if (seeded) {
          // Refresh history to show the sample item
          setHistoryRefreshToken((t) => t + 1);
        }
        setDbReady(true);
      })
      .catch((err) => console.error("Failed to init database:", err));
  }, []);

  // Load images when a history run is selected
  useEffect(() => {
    if (!selectedRun) {
      setViewingHistoryImages(null);
      return;
    }
    let cancelled = false;
    loadImagesForRun(selectedRun).then(
      ({ inputImage: inp, outputImage: out }) => {
        if (!cancelled) {
          setViewingHistoryImages({
            input: inp ?? "",
            output: out ?? "",
            runComment: selectedRun.humanComment ?? "",
          });
          setHistoryComment(selectedRun.humanComment ?? "");
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [selectedRun]);

  // Handle "Edit" - switch to edit mode, loading settings from history or keeping current
  const handleEditFromHistory = useCallback(() => {
    // If viewing history, load settings from history run
    if (selectedRun && viewingHistoryImages) {
      setInputImage(viewingHistoryImages.input);
      setReplacementText(selectedRun.newTitle);
      setPromptTemplate(selectedRun.promptTemplate);
      setSelectedModel(selectedRun.modelId);
      logEvent("history.edit", { details: { runId: selectedRun.id } });
    }
    // In both cases, clear output to switch to edit mode
    setOutputImage(null);
    setError("");
    setLastRun(null);
    setLastRunId(null);
    setLastRunComment("");

    // Clear history view state
    setSelectedRun(null);
    setViewingHistoryImages(null);
    setHistoryComment("");
  }, [
    selectedRun,
    viewingHistoryImages,
    setInputImage,
    setReplacementText,
    setPromptTemplate,
    setSelectedModel,
    logEvent,
  ]);

  // Handle "Start Over" - reset to defaults
  const handleStartOver = useCallback(() => {
    setInputImage(null);
    setOutputImage(null);
    setReplacementText("");
    setMatchText(MATCH_TEXT_MAIN_TITLE);
    setPromptTemplate(DEFAULT_PROMPT_TEMPLATE);
    setError("");
    setLastRun(null);
    setLastRunId(null);
    setLastRunComment("");

    // Clear history view state
    setSelectedRun(null);
    setViewingHistoryImages(null);
    setHistoryComment("");

    logEvent("history.startOver");
  }, [
    setInputImage,
    setReplacementText,
    setMatchText,
    setPromptTemplate,
    logEvent,
  ]);

  // Save comment for viewed history run
  const handleSaveHistoryComment = useCallback(async () => {
    if (!selectedRun) return;
    try {
      await updateRunComment(selectedRun.id, historyComment);
      setHistoryRefreshToken((t) => t + 1);
      logEvent("historyComment.saved", { details: { runId: selectedRun.id } });
    } catch (err) {
      console.error("Failed to save history comment:", err);
    }
  }, [selectedRun, historyComment, logEvent]);

  // Derive a clean model name for display (e.g., "GPT-5 Image Mini" from "openai/gpt-5-image-mini — GPT-5 Image Mini")
  const getCleanModelName = useCallback((label: string) => {
    // Label format is "model/id — Friendly Name", extract the friendly name
    const dashIndex = label.indexOf(" — ");
    if (dashIndex !== -1) {
      return label.slice(dashIndex + 3);
    }
    // Fallback: try to clean up model ID like "openai/gpt-5-image-mini"
    const slashIndex = label.lastIndexOf("/");
    if (slashIndex !== -1) {
      return label.slice(slashIndex + 1).replace(/-/g, " ");
    }
    return label;
  }, []);

  const selectedModelLabel = useMemo(() => {
    const model = models.find((m) => m.id === selectedModel);
    return model ? getCleanModelName(model.label) : selectedModel;
  }, [models, selectedModel, getCleanModelName]);

  // Detect Mac for keyboard shortcut display
  const isMac = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    );
  }, []);
  const pasteShortcut = isMac ? "⌘V" : "Ctrl+V";

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
        matchTextChars: matchText.trim().length,
        replacementTextChars: replacementText.trim().length,
        promptChars: promptTemplate.length,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [modelsReloadToken, _setModelsReloadToken] = useState(0);

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
          if (keep) return prev;
          // Prefer the recommended model if available
          const recommended = list.find(
            (m) => m.id === DEFAULT_RECOMMENDED_MODEL
          );
          return recommended?.id ?? list[0]?.id ?? prev;
        });
      } catch (err) {
        if (cancelled) return;
        const message =
          err &&
          typeof err === "object" &&
          "name" in err &&
          err.name === "AbortError"
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
      if (keep) return prev;
      // Prefer the recommended model if available
      const recommended = models.find(
        (m) => m.id === DEFAULT_RECOMMENDED_MODEL
      );
      return recommended?.id ?? models[0]?.id ?? prev;
    });
  }, [models, setSelectedModel]);

  // Global paste: image -> input image (only when connected to OpenRouter)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Don't allow paste if not connected to OpenRouter
      if (!apiKeyOpenRouter) return;

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
  }, [apiKeyOpenRouter]);

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

  const copyImage = useCallback(
    async (
      imageSrc: string,
      setSuccess: (v: boolean) => void,
      logName: string
    ) => {
      if (!imageSrc) return;

      try {
        // Clipboard API only supports image/png, so convert via canvas
        const img = new Image();
        img.crossOrigin = "anonymous";

        const pngBlob = await new Promise<Blob>((resolve, reject) => {
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              reject(new Error("Failed to get canvas context"));
              return;
            }
            ctx.drawImage(img, 0, 0);
            canvas.toBlob((blob) => {
              if (blob) {
                resolve(blob);
              } else {
                reject(new Error("Failed to create PNG blob"));
              }
            }, "image/png");
          };
          img.onerror = () => reject(new Error("Failed to load image"));
          img.src = imageSrc;
        });

        await navigator.clipboard.write([
          new ClipboardItem({
            "image/png": pngBlob,
          }),
        ]);
        setSuccess(true);
        setTimeout(() => setSuccess(false), 1500);
        logEvent(`${logName}.copy_image.success`, {
          details: { mimeType: "image/png", bytes: pngBlob.size },
        });
      } catch (err) {
        console.error(err);
        setError("Failed to copy image to clipboard.");
        logEvent(`${logName}.copy_image.error`, {
          details: { message: String(err) },
        });
      }
    },
    [logEvent]
  );

  const generate = async () => {
    if (!inputImage) {
      setError("Paste or upload an input image first.");
      return;
    }
    if (!replacementText.trim()) {
      setError("Enter the replacement text.");
      return;
    }

    if (!apiKeyOpenRouter.trim()) {
      setError("Connect to OpenRouter.ai first (link in top right).");
      return;
    }

    if (!selectedModel.trim()) {
      setError("Select an image model.");
      return;
    }

    setIsGenerating(true);
    setError("");

    // Debug: simulate errors for testing
    if (simulateError) {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Simulate some delay
      setIsGenerating(false);
      const errorMessages: Record<string, string> = {
        credits:
          "OpenRouter error: Insufficient credits. Please add credits at openrouter.ai/credits",
        unavailable:
          "OpenRouter error: Service temporarily unavailable. Please try again later.",
        timeout:
          "OpenRouter error: Request timed out. The model may be overloaded.",
        ratelimit:
          "OpenRouter error: Rate limit exceeded. Please wait a moment and try again.",
      };
      setError(
        errorMessages[simulateError] || `Simulated error: ${simulateError}`
      );
      logEvent("generate.simulated_error", {
        details: { errorType: simulateError },
      });
      return;
    }

    const prompt = compilePrompt(promptTemplate, matchText, replacementText);

    logEvent("generate.start", {
      provider: "openrouter",
      model: selectedModel,
      details: {
        matchTextChars: matchText.trim().length,
        replacementTextChars: replacementText.trim().length,
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
      setLastRunComment("");

      // Save to database
      if (dbReady) {
        try {
          const runToSave: RunInsert = {
            createdAt: new Date().toISOString(),
            modelId: selectedModel,
            modelLabel: selectedModelLabel,
            promptTemplate,
            compiledPrompt: prompt,
            newTitle: replacementText.trim(),
            inputImage,
            outputImage: result.imageUrl,
            servedBy: result.metrics.servedBy ?? null,
            route: result.metrics.route ?? null,
            promptTokens: result.metrics.promptTokens ?? null,
            completionTokens: result.metrics.completionTokens ?? null,
            totalTokens: result.metrics.totalTokens ?? null,
            cost: result.metrics.cost ?? null,
            durationMs: result.metrics.durationMs ?? null,
            humanComment: null,
          };
          const runId = await saveRun(runToSave);
          setLastRunId(runId);
          setHistoryRefreshToken((t) => t + 1);
          logEvent("db.save_run.success", {
            provider: "openrouter",
            model: selectedModel,
            details: { runId },
          });
        } catch (dbErr) {
          console.error("Failed to save run to database:", dbErr);
          logEvent("db.save_run.error", {
            provider: "openrouter",
            model: selectedModel,
            details: { message: String(dbErr) },
          });
        }
      }

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

  // Handle saving comment for last run (auto-save on blur)
  const handleSaveLastRunComment = useCallback(async () => {
    if (!lastRunId) return;
    try {
      await updateRunComment(lastRunId, lastRunComment);
      setHistoryRefreshToken((t) => t + 1);
      logEvent("db.update_comment.success", {
        details: { runId: lastRunId },
      });
    } catch (err) {
      console.error("Failed to save comment:", err);
    }
  }, [lastRunId, lastRunComment, logEvent]);

  return (
    <div className="h-screen bg-slate-950 text-slate-100 font-sans flex overflow-hidden">
      {/* Left side: header + history + images */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-slate-900 border-b border-slate-800 p-4 flex flex-col md:flex-row items-center justify-between shrink-0 gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <ImageIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Image Localizer Experiment</h1>
              <p className="text-xs text-slate-400">
                Replace text in images with AI
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full md:w-auto">
            {/* API key input commented out - using OAuth instead
            <div className="hidden md:flex items-center gap-2 text-xs text-slate-500">
              <span>
                Your key stays on your machine, sent directly to{" "}
                <a
                  href="https://openrouter.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 underline"
                >
                  OpenRouter.ai
                </a>
              </span>
              <span className="text-slate-600">→</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center bg-slate-950 rounded-md border border-slate-800 px-3 py-2 w-full md:w-64 focus-within:border-indigo-500">
                <Globe className="w-4 h-4 text-emerald-400 mr-2 shrink-0" />
                <input
                  type="password"
                  placeholder="Your OpenRouter.ai API key"
                  value={apiKeyOpenRouter}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    setApiKeyOpenRouter(e.target.value);
                    if (error === "Connect to OpenRouter.ai first (link in top right).") {
                      setError("");
                    }
                  }}
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
            </div>
            */}
            {apiKeyOpenRouter ? (
              <button
                onClick={() => {
                  setApiKeyOpenRouter("");
                  logEvent("oauth.disconnect");
                }}
                className="text-xs text-white hover:text-slate-300 underline whitespace-nowrap"
                title="Remove the stored API key"
              >
                Disconnect from OpenRouter.ai
              </button>
            ) : (
              <button
                onClick={async () => {
                  setOauthLoading(true);
                  logEvent("oauth.start");
                  try {
                    await initiateOAuthFlow();
                  } catch (err) {
                    setOauthLoading(false);
                    console.error("OAuth initiation error:", err);
                  }
                }}
                disabled={oauthLoading}
                className="text-xs text-indigo-400 hover:text-indigo-300 underline whitespace-nowrap"
                title="Connect to OpenRouter to use credits from your account"
              >
                {oauthLoading ? "Connecting…" : "Connect to OpenRouter.ai"}
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 flex min-h-0">
          {/* History Sidebar */}
          {dbReady && (
            <HistorySidebar
              selectedRunId={selectedRun?.id ?? null}
              onSelectRun={setSelectedRun}
              refreshToken={historyRefreshToken}
            />
          )}

          {/* Images section */}
          <section className="flex-1 p-4 md:p-6 overflow-auto min-w-0">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Input */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden min-w-0 flex flex-col max-h-[calc(100vh-10rem)]">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between shrink-0">
                  <div className="text-sm font-semibold">Input image</div>
                  {!selectedRun && apiKeyOpenRouter && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs px-2.5 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700"
                      >
                        <span className="inline-flex items-center gap-1">
                          <Upload className="w-3.5 h-3.5" /> Upload or{" "}
                          {pasteShortcut}
                        </span>
                      </button>
                    </div>
                  )}

                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleFileUpload}
                  />
                </div>

                <div className="p-4 min-h-0 flex-1 flex flex-col">
                  {(() => {
                    const displayImage =
                      viewingHistoryImages?.input || inputImage;
                    if (!displayImage) {
                      return (
                        <div className="border-2 border-dashed border-slate-700 rounded-xl p-10 text-slate-400 text-sm">
                          <div className="flex items-center gap-2 font-medium text-slate-300 mb-2">
                            <Upload className="w-4 h-4" /> Paste (
                            {pasteShortcut}) or upload
                          </div>
                        </div>
                      );
                    }
                    return (
                      <MagnifiableImage
                        src={displayImage}
                        alt="Input"
                        className="w-full max-h-[calc(50vh-4rem)] xl:max-h-[calc(70vh-4rem)] rounded-xl border border-slate-800 bg-slate-950"
                        onLoad={(dims) => setInputDimensions(dims)}
                        copyIcon={
                          <button
                            onClick={() =>
                              copyImage(
                                displayImage,
                                setInputCopySuccess,
                                "input"
                              )
                            }
                            className="hover:text-slate-300 transition-colors"
                            title="Copy to clipboard"
                          >
                            {inputCopySuccess ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        }
                      />
                    );
                  })()}
                </div>
              </div>

              {/* Output */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden relative min-w-0 flex flex-col max-h-[calc(100vh-10rem)]">
                <div className="p-4 border-b border-slate-800 shrink-0">
                  <div className="text-sm font-semibold">Output</div>
                </div>

                <div className="p-4 min-h-0 flex-1 flex flex-col">
                  {(() => {
                    const displayOutput =
                      viewingHistoryImages?.output || outputImage;
                    if (!displayOutput) {
                      return null;
                    }
                    return (
                      <MagnifiableImage
                        src={displayOutput}
                        alt="Output"
                        className="w-full max-h-[calc(50vh-4rem)] xl:max-h-[calc(70vh-4rem)] rounded-xl border border-slate-800 bg-slate-950"
                        expectedDimensions={inputDimensions}
                        copyIcon={
                          <button
                            onClick={() =>
                              copyImage(displayOutput, setCopySuccess, "output")
                            }
                            className="hover:text-slate-300 transition-colors"
                            title="Copy to clipboard"
                          >
                            {copySuccess ? (
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        }
                        downloadIcon={
                          <a
                            href={displayOutput}
                            download={`image.${getImageExtension(
                              displayOutput
                            )}`}
                            className="hover:text-slate-300 transition-colors"
                            title="Download image"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        }
                      />
                    );
                  })()}
                </div>

                {isGenerating && !selectedRun && (
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
        </div>
      </div>

      {/* Right sidebar - full height */}
      <aside className="w-[320px] lg:w-[360px] shrink-0 bg-slate-900 border-l border-slate-800 p-4 flex flex-col overflow-y-auto">
        {(() => {
          // Unified sidebar: editable when no output, not viewing history, and connected to OpenRouter
          const isViewingHistory = !!selectedRun;
          const hasOutput = !!outputImage;
          const isConnected = !!apiKeyOpenRouter;
          const isEditable = !isViewingHistory && !hasOutput && isConnected;

          // Get the current values to display (from history or current state)
          const displayMatchText = isViewingHistory
            ? MATCH_TEXT_MAIN_TITLE
            : matchText;
          const displayReplacementText = isViewingHistory
            ? selectedRun?.newTitle ?? ""
            : replacementText;
          const displayModelId = isViewingHistory
            ? selectedRun?.modelId ?? ""
            : selectedModel;
          const displayModelLabel = isViewingHistory
            ? getCleanModelName(selectedRun?.modelLabel ?? "")
            : selectedModelLabel;
          const displayPrompt = isViewingHistory
            ? selectedRun?.compiledPrompt ?? ""
            : promptTemplate;

          // Get run metrics (from history or last run)
          const runMetrics = isViewingHistory
            ? {
                durationMs: selectedRun?.durationMs,
                promptTokens: selectedRun?.promptTokens,
                completionTokens: selectedRun?.completionTokens,
                cost: selectedRun?.cost,
              }
            : lastRun;

          // Comment state
          const commentValue = isViewingHistory
            ? historyComment
            : lastRunComment;
          const setCommentValue = isViewingHistory
            ? setHistoryComment
            : setLastRunComment;
          const handleSaveComment = isViewingHistory
            ? handleSaveHistoryComment
            : handleSaveLastRunComment;

          // Run ID for saving comments
          const currentRunId = isViewingHistory ? selectedRun?.id : lastRunId;

          return (
            <div className="flex flex-col flex-1">
              {/* Top section - Find/Replace and Generate */}
              <div className="space-y-3">
                {/* Connect to OpenRouter - only show when not connected */}
                {!apiKeyOpenRouter && (
                  <div className="p-4 rounded-xl bg-indigo-950/50 border-2 border-indigo-500/30 text-sm space-y-4">
                    <p className="text-indigo-200 leading-relaxed">
                      This app uses AI services to process images. These
                      services charge about US$0.015 per image. The way you pay
                      for that is through OpenRouter.ai. If you don't already
                      have an account, OpenRouter.ai will give you a $1 free to
                      try it out. After that, you can add credits and tell it
                      how much of your credits this app is allowed to use. You
                      can disconnect any time.
                    </p>
                    <button
                      onClick={async () => {
                        setOauthLoading(true);
                        logEvent("oauth.start");
                        try {
                          await initiateOAuthFlow();
                        } catch (err) {
                          setOauthLoading(false);
                          console.error("OAuth initiation error:", err);
                        }
                      }}
                      disabled={oauthLoading}
                      className="w-full py-3 px-4 rounded-xl flex items-center justify-center font-semibold text-white transition-all active:scale-[0.99] bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500"
                    >
                      <Wand2 className="w-5 h-5 mr-2" />
                      {oauthLoading
                        ? "Connecting…"
                        : "Connect to OpenRouter.ai"}
                    </button>
                  </div>
                )}

                {/* Match Text */}
                <div
                  className={`text-sm font-medium ${
                    isEditable ? "text-slate-300" : "text-slate-500"
                  }`}
                >
                  Find text
                </div>
                <input
                  type="text"
                  list="matchTextOptions"
                  value={displayMatchText}
                  onChange={(e) => isEditable && setMatchText(e.target.value)}
                  onBlur={() =>
                    isEditable &&
                    logEvent("matchText.blur", {
                      provider: "openrouter",
                      model: selectedModel,
                      details: { matchTextChars: matchText.trim().length },
                    })
                  }
                  placeholder="e.g. The Fish, or select main title"
                  disabled={!isEditable}
                  className={`w-full border rounded-lg px-3 py-2 outline-none text-sm ${
                    isEditable
                      ? "bg-slate-950 border-slate-800 text-slate-100 focus:ring-2 focus:ring-indigo-500"
                      : "bg-slate-900/50 border-slate-800/50 text-slate-500 cursor-not-allowed"
                  }`}
                />
                <datalist id="matchTextOptions">
                  <option value={MATCH_TEXT_MAIN_TITLE} />
                </datalist>

                {/* Replacement Text */}
                <div
                  className={`text-sm font-medium ${
                    isEditable ? "text-slate-300" : "text-slate-500"
                  }`}
                >
                  Replace with
                </div>
                <textarea
                  value={displayReplacementText}
                  onChange={(e) =>
                    isEditable && setReplacementText(e.target.value)
                  }
                  onBlur={() =>
                    isEditable &&
                    logEvent("replacementText.blur", {
                      provider: "openrouter",
                      model: selectedModel,
                      details: {
                        replacementTextChars: replacementText.trim().length,
                      },
                    })
                  }
                  placeholder="e.g. The Little Robot"
                  rows={2}
                  disabled={!isEditable}
                  className={`w-full border rounded-lg px-3 py-2 outline-none text-sm resize-none ${
                    isEditable
                      ? "bg-slate-950 border-slate-800 text-slate-100 focus:ring-2 focus:ring-indigo-500"
                      : "bg-slate-900/50 border-slate-800/50 text-slate-500 cursor-not-allowed"
                  }`}
                />

                {error && (
                  <div className="p-3 bg-red-900/30 border border-red-800/40 rounded-xl flex items-start text-red-200 text-sm">
                    <AlertCircle className="w-4 h-4 mr-2 mt-0.5 shrink-0" />
                    <span className="break-words">{error}</span>
                  </div>
                )}

                {/* Generate button - only when connected */}
                {apiKeyOpenRouter && !isViewingHistory && !hasOutput && (
                  <button
                    onClick={generate}
                    disabled={isGenerating || !inputImage}
                    className={`w-full py-3 px-4 rounded-xl flex items-center justify-center font-semibold text-white transition-all active:scale-[0.99]
                    ${
                      isGenerating || !inputImage
                        ? "bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700"
                        : "bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500"
                    }`}
                  >
                    <Wand2
                      className={`w-5 h-5 mr-2 ${
                        isGenerating ? "animate-spin" : ""
                      }`}
                    />
                    {isGenerating
                      ? `Generating… ${Math.floor(elapsedSeconds / 60)}:${(
                          elapsedSeconds % 60
                        )
                          .toString()
                          .padStart(2, "0")}`
                      : "Generate"}
                  </button>
                )}

                {/* Run metrics - show when there's a run */}
                {runMetrics && !isGenerating && (
                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-400 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-200">
                        {displayModelLabel}
                      </span>
                      {runMetrics.durationMs != null && (
                        <span className="text-slate-300">
                          {formatDuration(runMetrics.durationMs)}
                        </span>
                      )}
                    </div>
                    {(runMetrics.promptTokens != null ||
                      runMetrics.completionTokens != null) && (
                      <div>
                        Tokens:{" "}
                        <span className="text-slate-300">
                          {runMetrics.promptTokens ?? "—"} →{" "}
                          {runMetrics.completionTokens ?? "—"}
                        </span>
                      </div>
                    )}
                    {runMetrics.cost != null && (
                      <div>
                        openrouter.ai charge:{" "}
                        <span className="text-slate-300">
                          {formatCost(runMetrics.cost)}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Notes - always editable, top-level section */}
                {currentRunId && (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium pt-2 text-slate-300">
                      <MessageSquare className="w-4 h-4" />
                      Your notes
                    </div>
                    <textarea
                      value={commentValue}
                      onChange={(e) => setCommentValue(e.target.value)}
                      onBlur={handleSaveComment}
                      placeholder="Quality notes…"
                      className={`w-full h-16 bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm outline-none resize-none focus:ring-2 focus:ring-indigo-500 ${
                        commentValue.trim()
                          ? "text-violet-300"
                          : "text-slate-100"
                      }`}
                    />
                  </>
                )}
              </div>

              {/* Bottom section - Model and Prompt */}
              <div className="mt-auto pt-4 space-y-3">
                <div
                  className={`text-sm font-medium mb-2 ${
                    isEditable ? "text-slate-300" : "text-slate-500"
                  }`}
                >
                  Model
                </div>
                <Select
                  value={
                    displayModelId
                      ? {
                          value: displayModelId,
                          label: isViewingHistory
                            ? displayModelLabel
                            : getCleanModelName(
                                models.find((m) => m.id === displayModelId)
                                  ?.label ?? displayModelId
                              ),
                        }
                      : null
                  }
                  onChange={(option) => {
                    if (isEditable && option) {
                      setSelectedModel(option.value);
                      logEvent("model.change", {
                        provider: "openrouter",
                        model: option.value,
                      });
                    }
                  }}
                  options={
                    modelsLoading
                      ? [{ value: "", label: "Loading…" }]
                      : models.length === 0
                      ? [{ value: "", label: "No models found" }]
                      : models
                          .filter((m) => !MODEL_META[m.id]?.hidden)
                          .sort((a, b) => {
                            const aRec = MODEL_META[a.id]?.recommended ? 1 : 0;
                            const bRec = MODEL_META[b.id]?.recommended ? 1 : 0;
                            return bRec - aRec; // recommended first
                          })
                          .map((m) => ({
                            value: m.id,
                            label: getCleanModelName(m.label),
                          }))
                  }
                  isDisabled={modelsLoading && models.length === 0}
                  isSearchable={false}
                  formatOptionLabel={(option) => {
                    const meta = MODEL_META[option.value];
                    return (
                      <div>
                        <div>{option.label}</div>
                        {meta?.subtitle && (
                          <div
                            style={{
                              fontSize: "10px",
                              color: meta.recommended
                                ? isEditable
                                  ? "rgb(74 222 128)"
                                  : "rgb(100 116 139)" // green-400 or slate-500
                                : isEditable
                                ? "rgb(251 191 36)"
                                : "rgb(100 116 139)", // amber-400 or slate-500
                              marginTop: "2px",
                            }}
                          >
                            {meta.subtitle}
                          </div>
                        )}
                      </div>
                    );
                  }}
                  styles={{
                    control: (base, state) => ({
                      ...base,
                      backgroundColor: "rgb(2 6 23)", // slate-950
                      borderColor: state.isFocused
                        ? "rgb(99 102 241)"
                        : "rgb(30 41 59)", // indigo-500 : slate-800
                      borderRadius: "0.5rem",
                      minHeight: "2.5rem",
                      fontSize: "12px",
                      boxShadow: state.isFocused
                        ? "0 0 0 2px rgb(99 102 241 / 0.5)"
                        : "none",
                      cursor: "pointer",
                      "&:hover": {
                        borderColor: state.isFocused
                          ? "rgb(99 102 241)"
                          : "rgb(51 65 85)", // slate-700
                      },
                    }),
                    singleValue: (base) => ({
                      ...base,
                      color: "rgb(226 232 240)", // slate-200
                      fontSize: "12px",
                      whiteSpace: "normal",
                      wordWrap: "break-word",
                    }),
                    menu: (base) => ({
                      ...base,
                      backgroundColor: "rgb(2 6 23)", // slate-950
                      border: "1px solid rgb(30 41 59)", // slate-800
                      borderRadius: "0.5rem",
                      zIndex: 50,
                      fontSize: "12px",
                    }),
                    option: (base, state) => ({
                      ...base,
                      backgroundColor: state.isSelected
                        ? "rgb(99 102 241)" // indigo-500
                        : state.isFocused
                        ? "rgb(30 41 59)" // slate-800
                        : "transparent",
                      color: "rgb(226 232 240)", // slate-200
                      fontSize: "12px",
                      whiteSpace: "normal",
                      wordWrap: "break-word",
                      padding: "0.5rem 0.75rem",
                      cursor: "pointer",
                      "&:active": {
                        backgroundColor: "rgb(67 56 202)", // indigo-700
                      },
                    }),
                    dropdownIndicator: (base) => ({
                      ...base,
                      color: "rgb(148 163 184)", // slate-400
                      "&:hover": {
                        color: "rgb(226 232 240)", // slate-200
                      },
                    }),
                    indicatorSeparator: () => ({
                      display: "none",
                    }),
                    input: (base) => ({
                      ...base,
                      color: "rgb(226 232 240)", // slate-200
                    }),
                    placeholder: (base) => ({
                      ...base,
                      color: "rgb(71 85 105)", // slate-600
                    }),
                  }}
                />
                {modelsError && (
                  <div className="text-xs text-amber-300 mt-1">
                    Failed to load models
                  </div>
                )}

                <div className="flex items-center justify-between pt-3">
                  <div
                    className={`text-sm font-medium ${
                      isEditable ? "text-slate-300" : "text-slate-500"
                    }`}
                  >
                    Prompt
                  </div>
                  {isEditable && (
                    <button
                      type="button"
                      onClick={() => {
                        setPromptTemplate(DEFAULT_PROMPT_TEMPLATE);
                        logEvent("prompt.restore_default");
                      }}
                      className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400"
                      title="Restore default prompt"
                    >
                      Reset
                    </button>
                  )}
                </div>

                <textarea
                  value={displayPrompt}
                  onChange={(e) =>
                    isEditable && setPromptTemplate(e.target.value)
                  }
                  onBlur={() =>
                    isEditable &&
                    logEvent("prompt.blur", {
                      provider: "openrouter",
                      model: selectedModel,
                      details: {
                        promptChars: promptTemplate.length,
                      },
                    })
                  }
                  disabled={!isEditable}
                  className={`w-full h-32 border rounded-lg p-3 outline-none resize-none font-mono text-xs ${
                    isEditable
                      ? "bg-slate-950 border-slate-800 text-slate-100 focus:ring-2 focus:ring-indigo-500"
                      : "bg-slate-900/50 border-slate-800/50 text-slate-500 cursor-not-allowed"
                  }`}
                />

                {/* Action buttons - show when viewing history or output (not for new users who haven't connected) */}
                {(isViewingHistory || hasOutput) && (
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleEditFromHistory}
                      className="flex-1 py-2 px-3 rounded-lg flex items-center justify-center text-sm font-medium text-white bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 transition-all active:scale-[0.99]"
                    >
                      Edit
                    </button>
                    <button
                      onClick={handleStartOver}
                      className="flex-1 py-2 px-3 rounded-lg flex items-center justify-center text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-all active:scale-[0.99]"
                    >
                      Start Over
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </aside>
    </div>
  );
}
