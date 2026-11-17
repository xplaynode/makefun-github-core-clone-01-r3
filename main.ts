// Entrypoint: start the forge and, when the harness provides
// MAKEFUN_ENV_URL, register the bound port and serve until the harness
// signals completion. Without it, serve until killed.

import { createApp } from './app.ts';

const server = createApp();

async function postJson(url: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function runHarnessLifecycle(envUrl: string, port: number): Promise<void> {
  const registerUrl = `${envUrl.replace(/\/$/, '')}/register`;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await postJson(registerUrl, { port })) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const doneUrl = `${envUrl.replace(/\/$/, '')}/done`;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(doneUrl);
      if (response.ok) {
        const payload = (await response.json()) as { done?: boolean };
        if (payload.done) break;
      }
    } catch {
      // Harness not reachable yet; keep serving and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

server.listen(0, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  console.log(`[entry] listening on port ${port}`);
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    void runHarnessLifecycle(envUrl, port);
  }
});
