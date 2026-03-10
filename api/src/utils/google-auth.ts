let cachedToken: { token: string; expiry: number } | null = null;

/**
 * Zero-dependency implementation of google auth to avoid deno incompatibility
 * with underlying process.env calls from logging util
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Gets an access token from the GCE metadata server (Cloud Run / GCE / GCF)
 * or falls back to `gcloud` CLI for local development.
 */
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiry) {
    return cachedToken.token;
  }

  // Try metadata server first (works on Cloud Run, GCE, Cloud Functions)
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
    );

    if (res.ok) {
      const data = await res.json() as any;
      cachedToken = {
        token: data.access_token,
        expiry: Date.now() + (data.expires_in - 30) * 1000,
      };
      return cachedToken.token;
    }
  } catch {
    // Not on GCP — fall through to gcloud CLI
  }

  // Fallback: local dev via gcloud CLI
  const proc = Bun.spawn(["gcloud", "auth", "print-access-token"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;

  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`gcloud auth failed: ${err}`);
  }

  const token = (await new Response(proc.stdout).text()).trim();
  cachedToken = {
    token,
    expiry: Date.now() + 30 * 60 * 1000, // ~30 min conservative
  };
  return token;
}

