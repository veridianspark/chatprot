# What did I miss?

A small, local-first app that turns a pile of unread chat messages into a short list of things that need you.

Paste a conversation (or open a WhatsApp export) and it will:

- **Summarise** the unread stretch: a headline, the key lines, and the main topics.
- **Flag important messages**: asks, questions, decisions, urgent wording, and mentions of you or everyone.
- **Rank by urgency** into three tiers: *Needs you now*, *Coming up*, and *Good to know*.
- **Pull out deadlines and times**, with live countdowns.

## Privacy

Everything runs in the browser tab.

- The page makes **no network requests**: no `fetch`, XHR, WebSocket, analytics or AI API calls.
- Your chat is held **only in React state**. It is never written to `localStorage`, cookies or a server.
- Opening a `.txt` file uses the browser's `FileReader`, so the file stays on your device.
- "Clear everything" wipes the chat and all marks from memory.
- Closing the tab discards everything. That is intentional.

To make the guarantee enforceable rather than just a promise, add a Content Security Policy with `connect-src 'none'` (see [Lock it down](#lock-it-down-optional)).

## Features

| Feature | What it does |
| --- | --- |
| Before and after counter | Shows unread count, how many need you, and estimated minutes saved (reading time at about 230 words a minute). |
| The short version | Up to four key messages chosen from the thread itself (extractive, not generated). |
| Unread strip | One bar per message (or bucket), oldest to newest. Taller means more urgent. Click a bar to jump to that message. |
| Deadline rail | A timeline from now to the furthest deadline (capped at 7 days). Pins are coloured by how close they are, and overlapping pins stack. |
| Deadlines list | Upcoming times sorted by due date, plus recently passed ones. Date phrases are highlighted inside the messages. |
| Triage mode | A full-screen, one-message-at-a-time flow with **Done**, **Later** and **Skip**. Keys: `D`, `L`, `S`, `U` or left arrow to go back, `Esc` to close. |
| Message detail | Each flagged message says why it was flagged, and can show the messages around it. |
| Copy summary | Copies a plain-text summary of what needs you and the upcoming deadlines. |

## Getting started

### Requirements

- Node.js 18 or later
- A Next.js project using the App Router (built and tried against Next.js 16)
- Tailwind CSS (the default option in `create-next-app`)

### Install

```bash
npx create-next-app@latest what-did-i-miss
# choose: TypeScript, Tailwind CSS, App Router

cd what-did-i-miss
```

Replace the generated `app/page.tsx` with the `page.tsx` from this project, then:

```bash
npm run dev
```

Open http://localhost:3000 and click **Try a sample chat**.

No other files, packages, API routes or environment variables are needed.

## How to use it

1. **Get your chat in.**
   - *WhatsApp:* open the chat, choose More, then Export chat, then Without media. Open the `.txt` file in the app.
   - *Anything else (Slack, Teams, Telegram, Discord):* select the messages, copy, and paste. Lines like `Name: message` work.
2. **Tell it who you are.** Enter your name so mentions of you are caught.
3. **Set what is unread.** Either add a line saying `--- unread ---` where you stopped reading, or pick "Last N messages". A marker line takes priority.
4. **Read the results.** Work through the tiers, or press **Start triage**.

### Supported formats

```text
12/03/2026, 21:41 - Priya: message          WhatsApp (Android)
[12/03/2026, 9:41:22 PM] Priya: message     WhatsApp (iOS)
[21:41] Priya: message                      bracketed time only
Priya: message                              plain
```

Multi-line messages are joined to the message above them.

## How it works

There is no model. Everything is plain, readable rules in one file:

1. **Parse** the text into messages (`parseChat`).
2. **Find times and deadlines** (`extractRefs`). It recognises phrases such as `EOD`, `tonight`, `tomorrow evening`, `Friday 4pm`, `15 Oct`, `12/03`, and `in 2 hours`. Relative words are resolved from each message's own timestamp.
3. **Score each message** (`scoreMessages`) from signals such as urgent wording, a mention of you, asks like "can you" or "please", decisions, questions, money, and how close a deadline is. Short replies like "ok" and "lol" score zero.
4. **Tier** by score: 5.5 or more is *Needs you now*, 3 or more is *Coming up*, and the rest is *Good to know*. Your own messages are never flagged.
5. **Summarise** (`buildSummary`) by picking the highest-scoring, non-duplicate lines and counting frequent topic words.

The scoring weights are all in `scoreMessages()` if you want to tune them.

## Lock it down (optional)

Add this to `next.config.ts` so the browser blocks any outbound request in production:

```ts
import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const csp = [
  "default-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    if (!isProd) return []; // dev server needs eval and websockets for hot reload
    return [{ source: "/(.*)", headers: [{ key: "Content-Security-Policy", value: csp }] }];
  },
};

export default nextConfig;
```

Test with `npm run build && npm start`. If the page breaks, `script-src` is the first thing to loosen.

## Limitations

This is a prototype. Please read these before relying on it.

- **Not tested on a wide range of real exports.** Export formats differ by phone, region and language. Day/month order is guessed as dd/mm unless the numbers say otherwise.
- **English only.** Urgency, ask and deadline detection use English keywords. Hindi, Hinglish and other languages will score poorly.
- **Heuristic scoring.** It will sometimes rank small talk too high or miss something that matters. Do not use it as the only way you catch critical messages.
- **Relative dates can be wrong.** "Friday" is resolved from the message timestamp. Chats without timestamps fall back to today.
- **Summaries are extractive.** It selects existing lines. It does not write new sentences.
- **Large chats are untested.** Very long exports (thousands of messages) have not been checked.
- **Nothing is saved.** Done and Later marks disappear when you close or refresh the tab.

## Roadmap ideas

- On-device AI summary using WebLLM or Transformers.js, still with no data leaving the browser.
- Draft reply suggestions for messages that need you.
- More chat formats (Slack, Telegram, Discord) and more languages.
- Installable PWA for offline use.
- Per-person view of who is asking you for what.
- Optional, opt-in local persistence of marks.

## Project layout

```text
app/
  page.tsx    The whole app: parsing, scoring, summary and UI
```

Main parts of `page.tsx`:

| Section | Purpose |
| --- | --- |
| `parseChat` | Turns raw text into messages |
| `extractRefs` | Finds deadlines and times |
| `scoreMessages` | Scores and tiers each message |
| `buildSummary` | Headline, key lines and topics |
| `analyze` | Ties it together and estimates reading time |
| `BeforeAfter`, `Rail`, `DeadlineRail`, `TriageMode`, `MessageRow` | UI pieces |
| `Page` | State, layout and wiring |
