export type WireCall = {
  url: string
  headers: Headers
  body: string
}

function responses(text: string) {
  const events = [
    {
      type: "response.created",
      response: { id: "resp_memory_qualification", object: "response", status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_memory_qualification", type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_memory_qualification",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_memory_qualification",
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: "msg_memory_qualification",
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.content_part.done",
      item_id: "msg_memory_qualification",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_memory_qualification",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_memory_qualification",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_memory_qualification",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

export function memoryFetch(calls: WireCall[], prior: typeof globalThis.fetch) {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const headers = new Headers(init?.headers ?? request?.headers)
      const body = String(init?.body ?? (await request?.clone().text()) ?? "")
      if (url === "https://models.dev/api.json") return Response.json({})
      calls.push({ url, headers, body })
      const instructions = body.toLowerCase()
      const text = instructions.includes("typed memory consolidation step")
        ? JSON.stringify({
            operations: [
              {
                op: "upsert_project_fact",
                key: "memory_test_command",
                value: "Run memory qualification with the packages/opencode test runner.",
              },
            ],
            skipped: [],
          })
        : JSON.stringify({
            topic: "test qualification",
            summary: "The session used a synthetic qualified memory capture.",
          })
      return responses(text)
    },
    { preconnect: prior.preconnect },
  )
}
