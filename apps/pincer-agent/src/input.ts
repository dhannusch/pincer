export function parseInputJson(inputRaw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputRaw);
  } catch {
    throw new Error("--input must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input must parse to a JSON object");
  }

  return parsed as Record<string, unknown>;
}
