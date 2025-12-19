export async function fetchJsonWithRetry(
	url: string,
	options: RequestInit,
	retries = 3,
	delayMs = 800,
): Promise<any> {
	try {
		const response = await fetch(url, options);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${text}`);
		}
		return await response.json();
	} catch (err) {
		if (retries <= 0) throw err;
		await new Promise((r) => setTimeout(r, delayMs));
		return fetchJsonWithRetry(url, options, retries - 1, delayMs * 2);
	}
}

export function dataUrlToParts(dataUrl: string): { mimeType: string; base64: string } {
	const [meta, base64] = dataUrl.split(',');
	const mimeType = meta.split(';')[0]?.split(':')[1];
	if (!mimeType || !base64) throw new Error('Invalid data URL');
	return { mimeType, base64 };
}

export function isProbablyImageUrl(value: string): boolean {
	return value.startsWith('data:image/') || /^https?:\/\//i.test(value) || /^blob:/i.test(value);
}

function extractFirstUrlFromText(text: string): string | null {
	const direct = text.match(/(https?:\/\/\S+)/i)?.[1];
	if (direct) return direct;

	const md = text.match(/\((https?:\/\/[^\)\s]+)\)/i)?.[1];
	if (md) return md;

	const data = text.match(/(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)+/i)?.[1];
	if (data) return data;

	return null;
}

export function extractImageUrlFromOpenRouterResponse(data: any): string | null {
	const message = data?.choices?.[0]?.message;
	const content = message?.content;

	const imagesArray = message?.images;
	if (Array.isArray(imagesArray)) {
		const first = imagesArray.find((img) => img?.image_url?.url);
		if (first?.image_url?.url) return String(first.image_url.url);
	}

	if (Array.isArray(content)) {
		const part = content.find((p) => p?.type === 'image_url' && p?.image_url?.url);
		if (part?.image_url?.url) return String(part.image_url.url);

		const maybeText = content.find((p) => p?.type === 'text' && typeof p?.text === 'string');
		if (maybeText?.text) {
			const url = extractFirstUrlFromText(maybeText.text);
			if (url) return url;
		}
	}

	if (typeof content === 'string') {
		if (isProbablyImageUrl(content.trim())) return content.trim();
		const url = extractFirstUrlFromText(content);
		if (url) return url;
	}

	const alt1 = data?.choices?.[0]?.message?.images?.[0];
	if (typeof alt1 === 'string' && alt1.length > 0) return alt1;
	if (alt1?.image_url?.url) return String(alt1.image_url.url);

	const alt2 = data?.output?.[0]?.content?.find?.((p: any) => p?.type === 'image_url')?.image_url?.url;
	if (typeof alt2 === 'string' && alt2.length > 0) return alt2;

	return null;
}
