export function responses(text: string) {
  const id = "msg_title_caller"
  const output = {
    id,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }
  const events = [
    { type: "response.created", response: { id: "resp_title_caller", object: "response", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id, type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text },
    {
      type: "response.content_part.done",
      item_id: id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: output },
    {
      type: "response.completed",
      response: {
        id: "resp_title_caller",
        object: "response",
        status: "completed",
        output: [output],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}
