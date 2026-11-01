export class NetworkError extends Error {
  constructor(message = 'Ingen forbindelse') {
    super(message);
    this.name = 'NetworkError';
  }
}

export async function fetchWithTimeout(fetchFn, url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: controller.signal });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }
}
