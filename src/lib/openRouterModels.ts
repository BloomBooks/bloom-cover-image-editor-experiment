export type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
  };
};

export type ImageEditModel = {
  id: string;
  label: string;
  inputModalities: string[];
  outputModalities: string[];
};

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

function normalizeModalities(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => typeof x === 'string')
    .map((x) => x.toLowerCase());
}

function isImageEditCapable(model: OpenRouterModel): boolean {
  const input = normalizeModalities(model.architecture?.input_modalities);
  const output = normalizeModalities(model.architecture?.output_modalities);
  return input.includes('image') && output.includes('image');
}

function labelFor(model: OpenRouterModel): string {
  const name = (model.name ?? '').trim();
  return name.length > 0 ? `${model.id} — ${name}` : model.id;
}

export async function fetchImageEditModels(opts?: {
  signal?: AbortSignal;
}): Promise<ImageEditModel[]> {
  const res = await fetch(MODELS_URL, { method: 'GET', signal: opts?.signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to load models: HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  const data: OpenRouterModel[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];

  return data
    .filter(isImageEditCapable)
    .map((m) => ({
      id: m.id,
      label: labelFor(m),
      inputModalities: normalizeModalities(m.architecture?.input_modalities),
      outputModalities: normalizeModalities(m.architecture?.output_modalities),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
