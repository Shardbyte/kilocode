const endpoint = process.env.KILO_TEST_OTLP_ENDPOINT
const headers = process.env.KILO_TEST_OTLP_HEADERS
if (!endpoint || !headers) throw new Error("OTLP qualification collector settings are missing")

// Otlp snapshots Flag's endpoint at module evaluation; load it before test/preload.ts clears the vars.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint
process.env.OTEL_EXPORTER_OTLP_HEADERS = headers

const { Flag } = await import("@opencode-ai/core/flag/flag")
Flag.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint
Flag.OTEL_EXPORTER_OTLP_HEADERS = headers
await import("@opencode-ai/core/observability/otlp")
