# Jarvin platform priorities

The next product milestone is a dependable spoken Windows task: “open a site, find this paragraph, click that control, fill this field, read back the result.” The model should be able to see a changing screen and act through real mouse and keyboard input. Each action should end with a fresh visual check. The floating pet remains present while the main window is hidden.

| Add or improve now | Why |
|---|---|
| Live screen buffer and visual grounding | Gives the assistant a recent frame and one-use target references. Never reuse a coordinate after an input or window change. |
| Tool choice and context engineering | Clear visual tasks now expose 39 relevant tools; the observed prompt shrank from about 7,257 to 3,466 tokens. Mixed and coding requests retain the full catalogue. Improve selection with measured task examples. |
| Voice turn taking and latency measurements | Qwen3-ASR is selected for accurate final English transcripts, Moonshine supplies quick interim text, and Piper speaks in chunks. Test end-to-end latency and echo behavior using the user's microphone and room noise, not only synthetic clips. |
| Agent runtime, sessions, traces, simulations | Jarvin has these in basic form. Add a reproducible Windows task benchmark and explain every failed action with its observed screen, timing and foreground-window check. |
| Policy and sandbox | Preserve permission rules for truly consequential actions. A safer default for routine local input can reduce repeated prompts while maintaining a clear stop control. |

| Extend after the core loop is dependable | Scope |
|---|---|
| MCP and connectors | Jarvin already has an MCP manager and a voice MCP server. Add vetted connectors for documents, calendar and browser tasks when a direct app integration is more reliable than mouse input. Cache tool catalogues to reduce prompt cost. |
| Skills and RAG | Jarvin has modes, memories and code search. Add small reusable task recipes and citation-backed retrieval for personal docs. Index only folders selected by the user. |
| Memory bank and knowledge graph | Start with searchable task facts and user corrections. A graph is useful when repeated people, projects and document relationships warrant it. |
| A2UI | Could provide structured task cards, editable forms and progress in the assistant window. It does not improve visual mouse control by itself. |
| A2A, gateway, registry, identity | Useful when Jarvin collaborates with independent local or remote agents, or when mobile control arrives. Design authentication and capability boundaries before enabling remote control. |
| Anomaly detection and optimizer | Use traces to detect repeated failed actions, wrong-window input, slow model calls and stale screenshots. Begin with clear rules and replayable evaluations. |

AP2 and UCP address payment and shopping flows. They do not help the current spoken desktop loop and should wait for an explicit commerce use case. A broad plugin marketplace also should wait until tool routing and permissions are measurable. External protocol references: [MCP](https://modelcontextprotocol.io/), [A2A](https://a2a-protocol.org/latest/), [A2UI](https://a2ui.org/), [UCP and AP2](https://developers.google.com/merchant/ucp/faq).
