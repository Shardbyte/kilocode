import { Flag } from "@opencode-ai/core/flag/flag"

const endpoint = process.env.KILO_TEST_OTLP_ENDPOINT
const headers = process.env.KILO_TEST_OTLP_HEADERS
if (!endpoint || !headers) throw new Error("OTLP qualification collector settings are missing")
process.stderr.write("OTLP_AFTER_TEST_PRELOAD\n")

process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint
process.env.OTEL_EXPORTER_OTLP_HEADERS = headers
Flag.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint
Flag.OTEL_EXPORTER_OTLP_HEADERS = headers

const { Effect } = await import("effect")
const { Observability } = await import("@opencode-ai/core/observability")
const { Otlp } = await import("@opencode-ai/core/observability/otlp")
if (!Otlp.loggers().length) throw new Error("OTLP module captured disabled endpoint before post-preload override")
const control = Effect.logInfo("OTLP_SESSION_CHILD_PRELOAD_LOG_CONTROL").pipe(
  Effect.withSpan("OTLP_SESSION_CHILD_PRELOAD_TRACE_CONTROL"),
  Effect.provide(Observability.layer),
)
await Effect.runPromise(Effect.scoped(control))
