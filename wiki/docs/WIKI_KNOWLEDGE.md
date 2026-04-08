---
source: file:docs/WIKI_KNOWLEDGE.md
last_updated: 2026-04-08T16:51:28.770Z
tags: [karpathy-wiki, llm-workbench, knowledge-management, rag-system, self-improving, documentation-loop, source-of-truth, version-control]
answers:
  - "How does the Karpathy-style persistent wiki work in LLM Workbench?"
  - "What is the step-by-step feedback loop for updating knowledge?"
  - "Which tools are available for scanning, indexing, and editing the wiki?"
  - "How does the system handle knowledge gaps and external validation?"
  - "What are the best practices for maintaining source truth versus compressed indexes?"
---
# Karpathy-Style LLM Wiki Management

This document defines the architecture and workflow for LLM Workbench's persistent, self-improving knowledge base inspired by Andrej Karpathy's vision. It details a dual-tier system where authoritative `docs/` files serve as the source of truth, while a compressed `wiki/` index enables fast, low-cost queries via grep and synthesis. The core mechanism is a six-step feedback loop: querying existing knowledge, identifying gaps, researching via web tools, updating source documentation, rebuilding the compressed index, and committing changes to version control. Key entities include the `wiki_scan`, `wiki_index`, `source_edit`, and `web_fetch` tools, which allow the system to autonomously detect stale data, validate external claims, and maintain an interlinked markdown ecosystem.

## Key topics
- Karpathy philosophy — Persistent, interlinked markdown wiki maintained by LLMs
- Feedback loop — Six-step cycle from gap detection to git commit
- Tool suite — Specific commands for scanning, indexing, editing, and researching
- Dual-tier RAG — Fast compressed overviews backed by full source fallback
- Trust & verification — Strategies to prevent hallucinations via source validation
- Workflow patterns — Examples for simple lookups, synthesis, and gap filling
- Best practices — Guidelines for keeping source truth and rebuilding indexes
- Version control — Git integration for tracking knowledge evolution