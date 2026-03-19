# Frontend Design Plugin (Claude Code)

Official Anthropic plugin (277K+ installs) that generates polished, distinctive frontend UI rather than generic AI-generated designs.

## What It Does
- Establishes a design framework (purpose, audience, aesthetic direction) before coding
- Produces bold typography, intentional color palettes, animations, spatial composition
- Avoids the typical "AI look" — generic purples, system fonts, cookie-cutter components

## Key Design Approach
1. Identify **purpose** of the interface
2. Identify **target audience**
3. Choose **specific aesthetic direction** (brutalist, maximalist, retro-futuristic, luxury, playful, etc.)

## Usage
- Invoke with `/frontend-design` and describe what you want
- Or activates automatically when asking Claude to build web components

## Where It Could Help This Project
- **Chat UI polish** — dark-themed interface in `index.html` / `app.js` could get a more distinctive look
- **Applet styling** — better default styles for iframe-based visualizations
- **Status panels** — E*TRADE auth flow, service indicators, slot panel could feel more cohesive
- **Sidebar/conversation list** — more refined layout and interactions

## Compatibility
Project uses vanilla JS + Tailwind CSS v4 (no framework) — good fit, plugin works directly with HTML/CSS/JS without requiring React or similar.
