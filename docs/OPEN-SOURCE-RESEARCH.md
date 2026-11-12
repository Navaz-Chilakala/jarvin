# Open-source research for Jarvin

Reviewed 2026-11-03 from the public repository documentation. Features below are the projects' descriptions, not independently verified behavior. No external code has been incorporated into Jarvin. Review exact licenses, dependencies and security behavior before using code.

On 2026-11-04, we also reviewed [UFO's AppAgent overview](https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/app_agent/overview.md), which describes combining screenshots and Windows UI Automation in an iterative action loop, and the README of [local-OpenComputerUse-AI-agent](https://github.com/mubinskt/local-OpenComputerUse-AI-agent), which describes an Ollama-based computer-use agent. Those descriptions informed the design; their performance was not independently tested and no code was copied.

| Project | License shown by repository | Relevance | Assessment |
|---|---|---|---|
| [Microsoft UFO](https://github.com/microsoft/UFO) | MIT | Windows UI Automation and Win32 agent; [Ollama configuration](https://github.com/microsoft/UFO/blob/main/documents/docs/configuration/models/ollama.md); [UI executor](https://github.com/microsoft/UFO/blob/main/documents/docs/mcp/servers/host_ui_executor.md). | Strong reference for semantic window and control interaction. Its Ollama documentation calls for at least 20k context; viability with this PC and Qwen 4B must be measured. It is a research system, not a drop-in completion of our brief. |
| [OpenJarvis](https://github.com/open-jarvis/OpenJarvis) | Apache-2.0 | Local-first agent framework, model runtime integrations and Windows desktop distribution. | Useful reference for model routing, evaluation and deployment. Replacing the current app or merging frameworks would require a separate integration and migration evaluation. |
| [Browser Agent](https://github.com/io-software-ai/browser-agent) | MIT | TypeScript browser extension, Ollama support, page elements, research with sources and action approvals. | Good reference for structured DOM interaction, source handling and browser security. At review this is a small project; claims need independent testing. Its default cloud mode must not be mistaken for local inference. |
| [JARVIS Local](https://github.com/Ag3nt47/JARVIS-Local) | MIT | Windows/Ollama desktop assistant, voice, memory, guarded actions and a HUD. | Close functional reference; Python architecture and limited project history mean it is not a drop-in substitute for the Electron app. |
| [pywinauto](https://github.com/pywinauto/pywinauto) | BSD-3-Clause (verify against upstream license when integrating) | Windows UI Automation and Win32 backends. | Candidate building block for a small separately scoped Windows adapter, subject to exclusion and permission enforcement. |

The public repositories [134ertel/jarvis](https://github.com/134ertel/jarvis) and [Axx33284/jarvis](https://github.com/Axx33284/jarvis) are also close conceptual references, but GitHub did not report a recognized license at review time; do not copy their code without clear permission. The latter's own safety documentation describes broad actions and fewer confirmations than this project's requirements.

## Candidate next work

1. Extend the initial Windows UI Automation adapter with fail-closed exclusions across every capture and input path. UI Automation alone does not provide complete visual understanding or work with every application.
2. Design a browser integration with explicit page scope, visible user approvals for consequential actions, source provenance and untrusted-page handling. Browser Agent's element references and approval design are useful references.
3. Compare OpenJarvis's model/runtime and evaluation interfaces against our existing Ollama client; avoid introducing a second backend unless it provides a demonstrated benefit.
4. Benchmark all proposed workflows on the existing `qwen3.5:4b` and the 8 GB GPU. Do not infer reliability from another project's README, model name, or star count.
