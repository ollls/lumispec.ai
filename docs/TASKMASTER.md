# TaskMaster: Context-Aware Task Pipelines

## Overview

TaskMaster is an advanced task orchestration system designed for efficient multi-step workflows, especially optimized for low-memory local LLMs. It provides **context management** and **context isolation** to prevent token bloat and maintain clean conversation boundaries.

---

## Core Concepts

### Context Management

- **Dynamic context building** — Each task step receives only relevant information
- **Token efficiency** — Prevents unnecessary context accumulation
- **State persistence** — Maintains task state across multiple turns
- **Selective memory** — Choose what gets carried forward

### Context Isolation

- **Per-task boundaries** — Each pipeline task operates in its own context window
- **No cross-contamination** — Task A's outputs don't pollute Task B's inputs
- **Clean handoffs** — Explicit data passing between tasks
- **Memory-friendly** — Critical for local LLMs with limited context

---

## Why It Matters for Local LLMs

### The Problem

Local LLMs (llama.cpp, Ollama, etc.) often have:
- **Limited context windows** (4K-32K tokens)
- **Restricted RAM** (context takes significant memory)
- **Slower inference** with larger contexts

Traditional multi-turn conversations accumulate:
```
Turn 1: 500 tokens
Turn 2: 500 + 500 = 1,000 tokens
Turn 3: 1,000 + 500 = 1,500 tokens
...
Turn 20: 10,000+ tokens (slow, memory-heavy)
```

### The TaskMaster Solution

```
Task 1: 500 tokens → isolate → extract result → clear context
Task 2: 500 tokens → isolate → extract result → clear context
Task 3: 500 tokens → isolate → extract result → clear context
...
Total: 500 tokens per task (constant memory footprint)
```

---

## Architecture

### Task Pipeline Structure

```
┌─────────────────────────────────────┐
│           Task Pipeline             │
├─────────────────────────────────────┤
│  ┌─────────┐    ┌─────────┐         │
│  │  Task 1 │────│  Task 2 │────     │
│  └─────────┘    └─────────┘         │
│     ↓              ↓                │
│  ┌─────────┐    ┌─────────┐         │
│  │ Context │    │ Context │         │
│  │  A      │    │  B      │         │
│  └─────────┘    └─────────┘         │
│     (isolated)   (isolated)         │
└─────────────────────────────────────┘
```

### Data Flow

1. **Input** → Task 1 with Context A
2. **Output** → Extract structured data
3. **Clear** → Context A released
4. **Pass** → Structured data to Task 2
5. **New Context** → Task 2 with Context B
6. **Repeat** → Until pipeline complete

---

## Use Cases

### 1. Multi-Step Research

```
Task 1: Search for topics
  ↓ (extract: list of URLs)
Task 2: Fetch each URL
  ↓ (extract: key findings)
Task 3: Synthesize report
  ↓ (final output)
```

**Context per task:** ~1,000 tokens  
**Without isolation:** ~10,000+ tokens

### 2. Code Generation & Review

```
Task 1: Generate code from spec
  ↓ (extract: code)
Task 2: Security review
  ↓ (extract: issues)
Task 3: Fix issues
  ↓ (final code)
```

### 3. Data Analysis Pipeline

```
Task 1: Load & clean CSV
  ↓ (extract: stats)
Task 2: Run analysis
  ↓ (extract: insights)
Task 3: Generate visualization
  ↓ (final chart)
```

---

## Configuration

### Pipeline Definition

```json
{
  "pipeline": {
    "name": "research_workflow",
    "tasks": [
      {
        "id": "search",
        "context": "isolated",
        "inputs": ["query"],
        "outputs": ["results"]
      },
      {
        "id": "fetch",
        "context": "isolated",
        "inputs": ["results.urls"],
        "outputs": ["content"]
      },
      {
        "id": "synthesize",
        "context": "isolated",
        "inputs": ["content"],
        "outputs": ["report"]
      }
    ]
  }
}
```

### Context Settings

```json
{
  "context": {
    "isolation": "per_task",
    "maxTokens": 4096,
    "carryForward": ["task_id", "user_query"],
    "clearAfter": true
  }
}
```

---

## Benefits

| Feature | Without TaskMaster | With TaskMaster |
|---------|-------------------|-----------------|
| **Memory Usage** | Grows linearly | Constant |
| **Speed** | Slows as context grows | Consistent |
| **Token Cost** | High (all history) | Low (per-task) |
| **Error Containment** | Pollutes all tasks | Isolated |
| **Local LLM Support** | Limited by RAM | Optimized |

---

## Implementation Details

### Context Lifecycle

```javascript
// Task starts
context = createContext(taskId, inputs)

// Task executes
toolCalls = executeTask(context)

// Task completes
result = extractStructuredData(toolCalls)
clearContext(context) // Memory freed!

// Pass to next task
nextTaskInputs = { ...result, ...carryForward }
```

### Data Extraction

- **Structured outputs** — JSON, CSV, key-value pairs
- **Type validation** — Ensure data integrity between tasks
- **Error handling** — Failed tasks don't corrupt pipeline

---

## Integration with Other Systems

### E*TRADE Pipelines

```
1. Search stocks (isolated context)
2. Fetch option chains (isolated context)
3. Calculate Greeks (isolated context)
4. Generate report (isolated context)
```

### Web Research Pipelines

```
1. Search topics (isolated context)
2. Fetch pages with stealth (isolated context)
3. Extract structured data (isolated context)
4. Synthesize findings (isolated context)
```

### Wiki Building Pipelines

```
1. Scan markdown files (isolated context)
2. Index file #1 (isolated context)
3. Index file #2 (isolated context)
... repeat for all files
```

---

## Best Practices

### 1. Keep Tasks Atomic

- One clear goal per task
- Minimal context requirements
- Structured outputs

### 2. Define Clear Interfaces

- Explicit input/output schemas
- Type validation between tasks
- Error handling at each boundary

### 3. Minimize Carry-Forward

- Only pass what's needed
- Don't carry full conversation history
- Extract structured data, not raw text

### 4. Test Isolation

- Verify tasks don't share state unexpectedly
- Check memory usage stays constant
- Validate error containment

---

## Future Enhancements

- **Parallel task execution** — Independent tasks run simultaneously
- **Checkpointing** — Resume interrupted pipelines
- **Task caching** — Skip unchanged inputs
- **Dynamic pipelines** — Branching based on task outputs
- **Visual pipeline builder** — GUI for task orchestration

---

## Summary

TaskMaster enables **efficient, memory-conscious multi-step workflows** by:

1. **Isolating context** per task
2. **Clearing memory** after each step
3. **Passing structured data** between tasks
4. **Optimizing for local LLMs** with limited resources

This is critical for running sophisticated AI workflows on consumer hardware with 8GB-32GB RAM and 4K-32K context windows.
