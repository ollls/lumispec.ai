# Video: search, playback and transcripts

Status: plan only, nothing built. Written 2026-11-14.

## The idea in one line

Videos play for the user; the model reads their captions. The model cannot watch a video, so
"working with video" means: find it, show it in the chat, and fetch the caption text YouTube already
stores alongside it (timestamped). The video and audio streams are never downloaded.

## What was measured, what was not

- **Measured 2026-11-14:** over plain HTTP, the watch page of a public video lists its caption
  tracks (English, German), but each caption URL answers `200` with an empty body. YouTube wants a
  browser-generated token on those URLs. Transcript fetch therefore has to go through the user's
  real Chrome (the Browser Search extension).
- **Checked on this machine:** `ffmpeg` is installed; `yt-dlp`, `deno` and Whisper are not. The
  extension has `scripting` and `<all_urls>`, and runs its page code in the isolated world.
- **Not tested:** everything about the in-browser route below. In particular, whether YouTube fills
  the transcript panel in an inactive tab (the same class of problem Gmail's inbox had). That is the
  first thing to test before building.

## Pieces

### 1. Video search
One more entry in the `ENGINES` table of `plugin-browser.js` (DuckDuckGo, Brave or Bing video
results, or YouTube's results page), returning title, channel, duration, date and URL.

Titles are a weak signal (clickbait), so the model should confirm a pick against the transcript
before relying on it.

### 2. Playback in the chat
A click-to-load card: thumbnail first, the official YouTube embed only after a click (no autoplay,
nothing loaded from YouTube until then).

- Build it as a host-page element, not an applet: embeds inside sandboxed `srcdoc` iframes tend to
  fail YouTube's referrer check (from memory, not tested here).
- Some videos, including many from news channels, disable embedding: the card needs an "open in
  tab" fallback.
- Timestamp links in an answer (`https://youtu.be/<id>?t=<seconds>`) should seek the card's player.

Playing a video in the extension's hidden tab is pointless: the extension reads the DOM, a playing
video adds nothing to it, and Chrome blocks background autoplay.

### 3. Transcript fetch

**Route A (recommended): open the transcript panel and read the DOM.**
Give the extension's `fetch` one generic addition: optional steps of "click this selector, wait for
that selector", then serialize as today. The server sends YouTube's selectors (the "Show
transcript" button, the transcript segment rows) and parses the rows with linkedom.
- Keeps the extension engine-agnostic: markup drift is fixed in a server-side table, no extension
  reload.
- The click/wait steps are reusable elsewhere ("show more", cookie banners).
- Risk: the panel may not render in an inactive tab. Test first.

**Route B (fallback): call YouTube's own transcript endpoint from inside the page.**
The page already holds the parameters the panel uses; a script in the page's main world makes the
same request with the page's cookies. No new permissions, but it puts YouTube-specific code in the
extension.

**Not recommended: `yt-dlp`.** Not installed, needs frequent updates to keep up with YouTube, and
(from memory) now also needs a JavaScript runtime such as Deno.

**Tool shape.** A separate tool in `plugin-browser.js`, e.g.
`video_transcript { url, lang?, start?, end? }`, not a `web_fetch` view, because it has no HTTP
fallback. It returns:
- title, channel, duration, language, and whether the captions are auto-generated (with a note that
  names and numbers may be wrong when they are);
- the text merged into roughly 30-second paragraphs prefixed `[mm:ss]` (raw segments are 2–4 s
  each; a timestamp on every one adds about 30% for nothing).

**Size** (speech is about 200 tokens a minute):

| Video length | Tokens (approx.) | Characters (approx.) |
|---|---|---|
| 10 minutes | 2K | 8K |
| 1 hour | 12K | 48K |
| 3 hours | 36K | 145K |

An hour sits at the 50,000-char tool-result ceiling (`MAX_TOOL_RESULT_CHARS`), so:
- up to about 20K chars: return the whole transcript;
- longer: save to `data/videos/<id>.md`, return the first part plus a note to read ranges with
  `start`/`end`, or open the file as a Book;
- cache by video id so follow-up questions do not reopen the tab.

### 4. Long videos as Books
A transcript is a text file, and Books already takes a single file: section splitting, search and
read-by-section exist. Sections should carry their timestamps. Fits lectures, interviews, earnings
calls.

### 5. News channel digest
A channel's RSS feed lists its latest uploads with no API key. Pull the transcripts and build a
daily digest as a template or a task pipeline, one subtask per channel, each item linked to its
timestamp.

### 6. Later, only if 1–5 prove useful
- **Whisper for videos without captions.** The 5090 is full (30.9 GB of 32 with the one-slot
  layout), so it runs on CPU. It also means downloading the audio, which is the part YouTube's
  terms object to.
- **Keyframes for slide or chart-heavy videos** (ffmpeg into the vision path). Costly in tokens.

## Limits to state in the UI and the prompt

- **Two kinds of captions.** Channel-uploaded ones are accurate; auto-generated ones are unreliable
  on names, tickers and numbers. The model cites the timestamp instead of presenting such a figure
  as verified.
- **No captions, no text.** Captions turned off, music, and live streams still in progress give
  nothing.
- **Speech only.** Charts, slides and text burned into the picture are invisible to the model
  unless the speaker reads them out.
- **YouTube only at first.** Other players (Vimeo, news sites' own) each need their own table
  entry, and many have no transcript at all.
- **A transcript is untrusted page content**, like any fetched page.

## What to avoid

- Downloading video files: against YouTube's terms, heavy on disk, and unnecessary.
- Fetching transcripts over plain HTTP: measured dead (see above).

## Build order

1. Video search plus the click-to-load card.
2. Transcript fetch for YouTube URLs (test Route A in an inactive tab first).
3. Long transcripts as Books.
4. News channel digest.
5. Whisper and keyframes.

Steps 1 and 2 make "find the video where X explains Y and tell me what they said" work end to end.
