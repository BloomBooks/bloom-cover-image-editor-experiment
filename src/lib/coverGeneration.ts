import { dataUrlToParts, extractImageUrlFromOpenRouterResponse, isProbablyImageUrl } from './utils';
import type { DebugProvider } from './debugLog';
import type { LogEventFn } from './useDebugLog';
import { summarizeText } from './debugLog';

export type RunMetrics = {
	provider: DebugProvider;
	model: string;
	servedBy?: string | null;
	route?: string | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	totalTokens?: number | null;
	cost?: number | null; // dollars
	currency?: string | null;
	requestId?: string | null;
	formattedCost?: string | null;
	durationMs?: number | null;
};

export type GenerateArgs = {
	model: string;
	prompt: string;
	inputDataUrl: string;
	apiKeyOpenRouter: string;
	logEvent: LogEventFn;
};

export type GenerateResult = {
	imageUrl: string;
	metrics: RunMetrics;
};

function toNumberMaybe(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim().length > 0) {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function pickFirstNonNull<T>(...values: Array<T | null | undefined>): T | null {
	for (const v of values) {
		if (v !== null && v !== undefined) return v;
	}
	return null;
}

export function formatCost(costDollars: number): string {
	const cents = costDollars * 100;
	return `${cents.toFixed(1)}¢`;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

function parseOpenRouterMetrics(data: any, headers: Headers, model: string): RunMetrics {
	const usage = data?.usage ?? data?.choices?.[0]?.usage ?? null;

	const promptTokens = pickFirstNonNull<number>(
		toNumberMaybe(usage?.prompt_tokens) as any,
		toNumberMaybe(usage?.input_tokens) as any,
	);

	const completionTokens = pickFirstNonNull<number>(
		toNumberMaybe(usage?.completion_tokens) as any,
		toNumberMaybe(usage?.output_tokens) as any,
	);

	const totalTokens = pickFirstNonNull<number>(
		toNumberMaybe(usage?.total_tokens) as any,
		promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null,
	);

	const costHeader = headers.get('x-openrouter-cost') ?? headers.get('x-openrouter-usage-cost');
	const cost = pickFirstNonNull<number>(
		toNumberMaybe(data?.cost) as any,
		toNumberMaybe(data?.usage?.cost) as any,
		toNumberMaybe(data?.usage?.total_cost) as any,
		toNumberMaybe(costHeader) as any,
	);

	const currency = pickFirstNonNull<string>(
		typeof data?.usage?.currency === 'string' ? data.usage.currency : null,
		typeof data?.currency === 'string' ? data.currency : null,
		null,
	);

	const servedBy = pickFirstNonNull<string>(
		typeof data?.provider === 'string' ? data.provider : null,
		typeof data?.provider?.name === 'string' ? data.provider.name : null,
		typeof data?.metadata?.provider === 'string' ? data.metadata.provider : null,
		headers.get('x-openrouter-provider'),
	);

	const route = pickFirstNonNull<string>(
		typeof data?.route === 'string' ? data.route : null,
		typeof data?.provider?.route === 'string' ? data.provider.route : null,
		headers.get('x-openrouter-route'),
	);

	const requestId = pickFirstNonNull<string>(
		typeof data?.id === 'string' ? data.id : null,
		headers.get('x-openrouter-request-id'),
		headers.get('x-request-id'),
	);

	return {
		provider: 'openrouter',
		model,
		servedBy,
		route,
		promptTokens,
		completionTokens,
		totalTokens,
		cost,
		currency,
		requestId,
		formattedCost: cost != null ? formatCost(cost) : null,
	};
}

export async function generateCover(args: GenerateArgs): Promise<GenerateResult> {
	const { inputDataUrl, model, prompt, logEvent } = args;
	const apiKey = args.apiKeyOpenRouter.trim();
	if (!apiKey) throw new Error('Missing OpenRouter API key');

	const startTime = performance.now();

	const { base64, mimeType } = dataUrlToParts(inputDataUrl);

	const requestBody: any = {
		model,
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: prompt },
					{
						type: 'image_url',
						image_url: { url: `data:${mimeType};base64,${base64}` },
					},
				],
			},
		],
		// Per OpenRouter docs: required for image generation.
		modalities: ['image', 'text'],
		stream: false,
	};

	logEvent('request.openrouter.start', {
		provider: 'openrouter',
		model,
		details: {
			endpoint: 'https://openrouter.ai/api/v1/chat/completions',
			mimeType,
			imageBase64Chars: base64.length,
			promptChars: prompt.length,
			promptPreview: summarizeText(prompt, 160),
		},
	});

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			'HTTP-Referer': window.location.href,
			'X-Title': 'CoverLocalizer',
		},
		body: JSON.stringify(requestBody),
	});

	const rawText = await response.text().catch(() => '');
	let data: any = null;
	try {
		data = rawText ? JSON.parse(rawText) : null;
	} catch {
		data = { _nonJsonBody: rawText };
	}

	const durationMs = performance.now() - startTime;
	const metrics = parseOpenRouterMetrics(data, response.headers, model);
	metrics.durationMs = durationMs;

	if (!response.ok) {
		logEvent('request.openrouter.error', {
			provider: 'openrouter',
			model,
			details: {
				status: response.status,
				statusText: response.statusText,
				metrics,
				bodyPreview: typeof rawText === 'string' ? summarizeText(rawText, 800) : null,
				headerProvider: response.headers.get('x-openrouter-provider'),
				headerRoute: response.headers.get('x-openrouter-route'),
				headerCost: response.headers.get('x-openrouter-cost'),
			},
		});

		throw new Error(`HTTP ${response.status}: ${summarizeText(rawText || response.statusText, 600)}`);
	}

	logEvent('request.openrouter.response', {
		provider: 'openrouter',
		model,
		details: {
			requestId: metrics.requestId,
			servedBy: metrics.servedBy,
			route: metrics.route,
			promptTokens: metrics.promptTokens,
			completionTokens: metrics.completionTokens,
			totalTokens: metrics.totalTokens,
			cost: metrics.cost,
			formattedCost: metrics.formattedCost,
			currency: metrics.currency,
			contentType: Array.isArray(data?.choices?.[0]?.message?.content)
				? 'array'
				: typeof data?.choices?.[0]?.message?.content,
			hasImagesArray: Boolean(data?.choices?.[0]?.message?.images),
		},
	});

	const extracted = extractImageUrlFromOpenRouterResponse(data);
	if (extracted && isProbablyImageUrl(extracted)) {
		return { imageUrl: extracted, metrics };
	}

	const content = data?.choices?.[0]?.message?.content;
	if (typeof content === 'string') {
		throw new Error(
			`OpenRouter returned text (not an image). Try an image-capable model. Text: ${content.slice(0, 200)}`,
		);
	}

	throw new Error('OpenRouter did not return an image.');
}
