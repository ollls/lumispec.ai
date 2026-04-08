# LLM Workbench — User Guide

## Getting Started

LLM Workbench is a chat interface that connects to a local AI model. You talk to the AI, and it can search the web, run code, check weather, manage travel bookings, and more.

### Creating a Chat

Click one of the **7 colored + buttons** in the top bar to start a new chat. Each color represents a session type. If a session prompt is saved for that color, it will be auto-submitted to set up the conversation.

You must create a session before you can type messages, use prompts, or access menus.

### Sending Messages

Type in the text box at the bottom and press **Enter** to send. Use **Shift+Enter** for a new line. You can also attach images by clicking the attach button, dragging files onto the input area, or pasting from clipboard.

### Switching Chats

Click any conversation in the left sidebar to switch to it. Your previous chat is preserved — switch back anytime.

## Top Bar

The top bar shows the status of connected services:

- **LLM** — which AI model is active (click to switch between local model and Claude)
- **Internet** — whether you're online
- **Search** — which search engine is active (click to switch)
- **LiteAPI** — travel/hotel service status
- **E*TRADE** — trading account connection status
- **Context** — how much of the AI's memory is being used (progress bar)
- **Timer** — shows elapsed time while the AI is thinking

## Menus

### Tools
Toggle individual AI tools on/off. When a tool is disabled, the AI won't use it.

### Prompts
Saved text snippets you can quickly load into the input box. Click a prompt to use it. Use the grip handle on the left to reorder, the pencil to rename, and the X to delete.

**Saving a prompt:** Type text in the input box and click **Save** (below Send). A title is auto-generated.

### Sessions
Saved prompts tied to session colors. When you click a colored + button, the matching session prompt auto-loads. Manage them the same way as prompts — reorder, rename, delete.

**Saving a session prompt:** Type text in the input and click **Save Session**. It saves for the current session color.

### Templates
Saved HTML visualizations (charts, dashboards). Click a template to insert a `[template: Name]` tag into your message. The AI will generate a fresh version of that visualization with updated data.

## Checkboxes

- **Applets** — when on, the AI can create interactive charts and visualizations in your chat
- **Autorun** — when on, code execution, shell commands, and source code edits run without asking for approval first (except project switching and git push, which always ask)
- **Think** — when on, shows the AI's reasoning process and tool usage. Turn off for cleaner output

## What the AI Can Do

### Search & Browse
Ask it to search the web or fetch content from a URL. Example: "Search for best restaurants in Miami" or "Summarize this article: [url]"

### Weather
Ask about weather anywhere. It knows your default location. Example: "Weather this week" or "Weather in Tokyo"

### Run Code
Ask it to write and run Python scripts. Results, charts, and files are saved automatically. Example: "Create a chart of Apple stock prices"

### Shell Commands
Ask it to run system commands. Each command shows a preview and requires approval (unless Autorun is on). Example: "Show disk usage" or "List files in my home directory"

### Code Development
The AI can read, edit, and manage source code in any project. Point it at a project directory and it becomes a coding assistant:

- **Browse code** — read files, search with regex, view project structure
- **Edit code** — targeted find-and-replace edits with color-coded diff previews (green = added, red = removed)
- **Write files** — create new files or fully replace existing ones, with diff preview
- **Delete files** — remove files during refactors
- **Git** — commit, diff, branch, push — with safety tiers that block destructive operations (force push, reset --hard)
- **Run tests** — verify changes with your project's test command
- **Switch projects** — tell the AI "work on ~/prj/other-project" and all tools retarget

Diffs are always shown — even with Autorun enabled — so you can see exactly what changed.

**Setup:** Set `SOURCE_DIR` in `.env` to your project root. Optionally set `SOURCE_TEST` to your test command (e.g. `npm test`, `pytest`, `cargo test`).

**Safety:** Destructive git operations are blocked. Remote operations (push/pull) always require approval regardless of Autorun. Switching projects always requires approval.

### Charts & Dashboards
With Applets enabled, ask for visualizations. Example: "Create a pie chart of my monthly expenses" or "Build a weather dashboard for my location"

### Templates
If you've saved a visualization you like, reference it by name: "Show weather [template: Weather]". The AI recreates the same layout with fresh data.

### File Management
The AI can save files, read them back, and list what's in the data folder. Example: "Save this as a CSV" or "What files do I have?"

### Travel & Hotels
Search for hotels, check rates, read reviews, and book rooms. Example: "Find hotels in Barcelona for next weekend"

### E*TRADE
If connected, check your portfolio, get stock quotes, view option chains, and analyze positions. Connect via the E*TRADE status indicator in the top bar.

### Logs
The app maintains detailed logs of all tool interactions in `./logs/` folder with daily files (e.g., `tools_2026-03-26.log`). These logs include:
- Web searches and fetched content
- Code execution and shell commands
- File read/write operations
- E*TRADE queries and hotel bookings
- Errors and failures

Ask about logs for details like "What web searches did I run today?" or "Show me all file edits from yesterday."

## Prompt Variables

Use special variables in prompts and sessions that get filled in automatically or prompt you for input:

**Auto-filled (no prompt):**
- `{$date}` — today's date
- `{$time}` — current time
- `{$day}` — day of the week
- `{$month}` — month name
- `{$year}` — current year
- `{$location}` — your configured location

**User-prompted (a dialog asks you to fill in):**
- `{$City}` — asks for text input
- `{$CheckIn:date}` — shows a date picker
- `{$Stay:daterange}` — shows a date range picker
- `{$Month:month}` — shows a month picker

Example prompt: "Weather in {$City} from {$CheckIn:date} to {$CheckOut:date}"

## Command Approval

When the AI wants to run a shell command, Python script, or edit source code (with Autorun off), you'll see a preview of what it wants to execute. For code edits, the preview shows a color-coded diff. Press **Enter** or click **Approve** to allow it, or click **Deny** to block it.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| Enter | Send message / Approve command |
| Shift+Enter | New line in message |
| Escape | Close popup dialogs |

## Tips

- The AI remembers your conversation context — refer back to earlier messages
- Long responses show a live timer so you know it's working
- If the AI seems stuck, check if Autorun is off — it might be waiting for command approval
- Save visualizations you like as templates — reuse them with fresh data anytime
- Use session prompts to set up specialized assistants (weather, coding, trading, support)
- Set up `SOURCE_DIR` and `SOURCE_TEST` in `.env` to use the AI as a coding assistant on any project
- Pin important conversations (📌) to keep them across server restarts
