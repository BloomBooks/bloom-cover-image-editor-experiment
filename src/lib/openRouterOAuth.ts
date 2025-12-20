/**
 * OpenRouter OAuth PKCE flow for obtaining user-controlled API keys.
 * See: https://openrouter.ai/docs/guides/overview/auth/oauth
 */

const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const CODE_VERIFIER_KEY = "openrouter_code_verifier";

/**
 * Generate a cryptographically random code verifier for PKCE.
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Create a SHA-256 code challenge from the verifier (S256 method).
 */
async function createCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);

  // Convert to base64url
  const hashArray = new Uint8Array(hash);
  const base64 = btoa(String.fromCharCode(...hashArray));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Initiate the OAuth PKCE flow by redirecting the user to OpenRouter.
 * The callback URL will be the current page.
 */
export async function initiateOAuthFlow(): Promise<void> {
  // Generate and store the code verifier
  const codeVerifier = generateCodeVerifier();
  sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);

  // Create the code challenge
  const codeChallenge = await createCodeChallenge(codeVerifier);

  // Build the auth URL
  const callbackUrl = window.location.origin + window.location.pathname;
  const authUrl = new URL(OPENROUTER_AUTH_URL);
  authUrl.searchParams.set("callback_url", callbackUrl);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  // Redirect to OpenRouter
  window.location.href = authUrl.toString();
}

/**
 * Check if we're returning from an OAuth callback and extract the code.
 * Returns the code if present, null otherwise.
 */
export function getOAuthCodeFromUrl(): string | null {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("code");
}

/**
 * Exchange the OAuth code for an API key.
 * Returns the API key on success, throws on failure.
 */
export async function exchangeCodeForApiKey(code: string): Promise<string> {
  const codeVerifier = sessionStorage.getItem(CODE_VERIFIER_KEY);

  if (!codeVerifier) {
    throw new Error("No code verifier found. Please try the OAuth flow again.");
  }

  const response = await fetch(OPENROUTER_KEYS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange code: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  // Clean up
  sessionStorage.removeItem(CODE_VERIFIER_KEY);

  // Clear the code from the URL without reloading
  const cleanUrl = window.location.origin + window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);

  return data.key;
}

/**
 * Check for OAuth callback and handle the code exchange.
 * Returns the API key if successful, null if no OAuth callback is present.
 * Throws on exchange errors.
 */
export async function handleOAuthCallback(): Promise<string | null> {
  const code = getOAuthCodeFromUrl();

  if (!code) {
    return null;
  }

  return exchangeCodeForApiKey(code);
}
