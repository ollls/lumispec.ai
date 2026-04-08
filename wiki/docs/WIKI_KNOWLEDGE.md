---
source: file:docs/WIKI_KNOWLEDGE.md
last_updated: 2026-04-08T16:59:48.551Z
tags: [karpathy-wiki, llm-workbench, rag-architecture, self-improving-system, docs-management, tool-suite, version-control, knowledge-validation]
answers:
  - "How does the Karpathy-style persistent wiki feedback loop work?"
  - "What is the difference between the docs/ source and wiki/ index?"
  - "Which tools are available for scanning, indexing, and updating the knowledge base?"
  - "How does the system detect and fill knowledge gaps using web research?"
  - "What is the workflow for committing and syncing wiki changes to Git?"
---
# Karpathy-Style LLM Wiki Architecture

This document defines the architecture and operational workflow for a persistent, self-improving knowledge base inspired by Andrej Karpathy's vision, implemented within the LLM Workbench. It details a dual-tier RAG system where authoritative `docs/` files serve as the source of truth, while a compressed `wiki/` directory enables fast, interlinked querying. The system employs a six-step feedback loop involving gap detection, external web research via `web_search` and `web_fetch`, source documentation updates, and iterative re-indexing using `wiki_index`. Key mechanisms include context isolation for stateless file processing, explicit progress tracking during bulk rebuilds, and strict version control integration to ensure trust and auditability of AI-generated knowledge.

## Key topics
- Karpathy philosophy — Persistent, interlinked markdown wiki maintained by LLMs
- Feedback loop — Six-step cycle from query to gap detection, research, and commit
- Tool suite — Specific commands like `wiki_scan`, `wiki_index`, `source_edit`, and `source_git`
- Dual-tier RAG — Compressed overviews for speed with full source fallback for detail
- Context isolation — Stateless per-file summarization to bound memory usage
- Trust & verification — Strategies to prevent hallucinations via source validation and Git history
- Workflow patterns — Scenarios for simple lookups, multi-source synthesis, and gap filling