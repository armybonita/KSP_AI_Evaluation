export async function register(): Promise<void> {
  // The AI client uses Node-only modules; middleware also starts the Edge runtime.
  if (process.env.NEXT_RUNTIME !== 'edge') {
    const { validateAiStartupConfig } = await import('./server/ai/client');
    validateAiStartupConfig();
  }
}
