
# ChatProt — Project Master Prompt

## 1. Project Identity

**Project Name:** ChatProt  
**Core Concept:** The Unread Problem — What Did I Miss?  
**Repository:** https://github.com/veridianspark/chatprot

ChatProt is a privacy-first AI micro app that helps users understand, summarize, and prioritize important information buried in overwhelming unread conversations.

The goal is simple:

> Help users catch up on what matters without reading every single message.

ChatProt should feel like a polished, intelligent, modern productivity product—not a generic chatbot or a basic dashboard template.

---

## 2. The Problem We Solve

People receive too many messages across chats, groups, communities, and work conversations.

Important information gets buried:
- Urgent requests go unnoticed.
- Deadlines are missed.
- Tasks and action items are forgotten.
- Important decisions disappear in long threads.
- Users waste time catching up on conversations.

ChatProt turns conversation overload into clarity and actionable next steps.

---

## 3. Core Features

### A. Smart Conversation Summaries
- Summarize long conversations into concise, readable briefs.
- Explain what happened while the user was away.
- Preserve important context, decisions, and conclusions.
- Avoid repeating irrelevant messages.
- Allow users to expand summaries for more detail.

### B. Important Message Detection
Identify messages containing:
- Direct requests and questions.
- Important announcements.
- Decisions and commitments.
- Changes to plans.
- Messages requiring a response.
- Information relevant to the user's responsibilities.

### C. Urgency and Priority
Classify important messages using transparent criteria:
- **Urgent:** Immediate action or a near-term deadline.
- **High:** Important task, request, or decision requiring attention soon.
- **Normal:** Useful information that can wait.
- **Low:** Informational or non-actionable content.

Do not label messages urgent without supporting evidence.

Distinguish actual deadlines from inferred urgency. Never invent a deadline or claim that a message is urgent solely because it contains emotional language.

### D. Deadline Detection
- Extract explicit dates, times, and due dates.
- Highlight upcoming deadlines.
- Preserve the original wording of deadlines.
- Identify ambiguous dates and ask for clarification when necessary.
- Avoid treating hypothetical dates or past events as future deadlines.

### E. Action Items
Extract:
- Tasks the user needs to complete.
- Questions awaiting the user's reply.
- Commitments made by participants.
- Decisions that affect next steps.
- Tasks assigned to other people when relevant.

Where possible, identify the responsible person and deadline.

### F. Multilingual Support
- Detect the language of imported conversations.
- Support summarization across languages where the local model allows it.
- Offer translation into a user-selected language.
- Preserve names, dates, links, and important technical terms.
- Make uncertainty clear instead of silently mistranslating important information.

### G. Search and Filtering
Allow users to:
- Search imported conversations.
- Filter messages by priority.
- View urgent items and deadlines.
- Find unresolved questions and action items.
- Mark items as reviewed or completed.

### H. Catch-Up Brief
Provide a clear overview containing:
1. What happened?
2. What is important?
3. What needs attention first?
4. What deadlines are approaching?
5. What should the user do next?

---

## 4. Privacy-First Architecture — Non-Negotiable

Privacy is a core product requirement, not a marketing feature.

### Required principles
- Process conversation content locally on the user's device.
- Keep imported messages and generated summaries on the device.
- Do not send private conversations to cloud AI APIs.
- Do not upload conversations to a backend server.
- Do not include message content in analytics, telemetry, or logs.
- Do not expose private message contents through error reports.
- Minimize data collection and provide clear controls to delete imported data.
- Explain model downloads and local storage behavior to users.

### Local AI
Use a browser-compatible, on-device model for genuine AI summarization, extraction, and translation.

Evaluate options based on:
- Browser compatibility.
- Device memory and processing requirements.
- Model download size.
- Supported languages.
- Inference speed.
- Offline behavior.
- License and redistribution requirements.

A model downloaded from a third-party provider may involve a network request. Explain this separately from sending user conversations to a cloud model.

### Strict restrictions
- Do not use Gemini, OpenAI, or another cloud API to process private conversation content.
- Do not create a backend endpoint that forwards conversation text to an external service.
- Do not claim processing is local unless the implementation actually guarantees it.
- Do not silently upload data for debugging or model improvement.
- Do not store secrets in client-side code.

If a feature cannot be implemented privately with the current architecture, explain the limitation and propose a privacy-preserving alternative.

---

## 5. Technology Stack

Use the existing project stack unless a change is justified.

- Next.js
- React
- TypeScript
- CSS
- Browser APIs and local storage technologies where appropriate
- A suitable browser-based AI inference library or locally executed model

Prefer simple, maintainable dependencies. Avoid unnecessary libraries and infrastructure.

Do not introduce a database, authentication system, cloud backend, or external API unless the product genuinely requires it and the privacy implications are explained.

---

## 6. UI and UX Direction

ChatProt should have a distinctive, polished productivity interface.

### Design principles
- Clean, modern, minimal, and premium.
- Clear visual hierarchy.
- Comfortable spacing and readable typography.
- Responsive layouts for desktop, tablet, and mobile.
- Accessible color contrast and keyboard navigation.
- Smooth, restrained transitions.
- Useful empty states and helpful error messages.
- Light and dark themes where appropriate.

### Suggested dashboard structure
- Sidebar navigation.
- Catch-up overview.
- Urgent messages.
- Upcoming deadlines.
- Action items.
- Recent conversations.
- Search and filtering controls.
- Privacy and model status indicators.

Use color intentionally:
- Red or equivalent warning styling for genuinely urgent items.
- Amber for upcoming deadlines or caution.
- Neutral styling for ordinary information.
- Green for completed actions when appropriate.

Never rely on color alone to communicate priority.

Avoid excessive gradients, unnecessary animations, clutter, and generic template styling.

---

## 7. Technical Quality Requirements

All changes must be reliable and maintainable.

- Use TypeScript correctly.
- Avoid `any` unless there is a documented reason.
- Keep components focused and reusable.
- Separate UI rendering from business logic.
- Validate imported input.
- Handle empty, malformed, and very large conversations.
- Add loading, success, and error states.
- Handle unavailable models and unsupported browsers gracefully.
- Prevent duplicate actions and unnecessary repeated processing.
- Clean up event listeners and resources when appropriate.
- Never silently discard user content.
- Never fabricate summaries, messages, deadlines, or analysis results.

Clearly distinguish actual AI results from rule-based estimates.

---

## 8. Performance and Offline Behavior

- Keep the initial interface lightweight.
- Avoid loading large AI models before users need them.
- Display model download progress and explain model size.
- Provide cancellation where practical.
- Handle low-memory devices gracefully.
- Cache model assets only when supported and appropriate.
- Make clear which features work offline.
- Do not claim full offline support until network-independent behavior has been tested.

---

## 9. Development Workflow

Before making changes:

1. Inspect the existing project structure.
2. Read `package.json` and relevant application files.
3. Understand the existing components and styles.
4. Identify which features already work.
5. Avoid replacing working code unnecessarily.

When implementing a feature:

1. Explain briefly what will change.
2. Make the smallest reliable set of changes.
3. Provide complete code for files that must be replaced.
4. Include installation commands for any new dependencies.
5. Run or recommend appropriate checks.
6. Fix TypeScript, lint, and build errors.
7. Explain how to test the feature manually.

Never invent file paths, dependencies, or successful test results.

Do not overwrite configuration files without checking their current contents.

---

## 10. Current Project Status

ChatProt began as a Next.js application with an initial dashboard prototype.

Treat the existing repository as the source of truth.

Before declaring any feature implemented, verify that it exists and works in the current codebase.

The following capabilities are product goals until verified:
- Genuine AI conversation summarization.
- Reliable urgency and deadline extraction.
- Action-item identification.
- Multilingual summarization and translation.
- Fully on-device AI processing.
- Verified privacy and offline guarantees.

Update this section as the project evolves.

---

## 11. Definition of Done

A feature is complete only when:
- It works in the actual application.
- The UI handles success, loading, and failure states.
- Input is validated appropriately.
- TypeScript and lint checks pass where configured.
- Existing features have not been unintentionally broken.
- Privacy requirements are respected.
- Any limitations are documented.
- The README and project instructions are updated when necessary.

Never mark a planned feature as complete merely because its UI has been created.

---

## 12. Product Philosophy

ChatProt should reduce cognitive overload, not create more of it.

Prioritize:
1. Accuracy over flashy AI claims.
2. Privacy over convenience shortcuts.
3. Useful actions over excessive summaries.
4. Clear explanations over unexplained AI decisions.
5. Simplicity over unnecessary complexity.
6. Honest limitations over false promises.

The product should help users answer one question with confidence:

**"What did I miss, what matters, and what should I do next?"**

---

## Final Instruction for AI Coding Assistants

Act as a careful senior engineer and product designer working on ChatProt.

Understand the existing code before changing it. Build incrementally, preserve working functionality, respect local-first privacy, and verify implementation details.

Do not rebuild the entire project when a focused change is sufficient.

Do not claim that AI, translation, local processing, or privacy guarantees work unless they have been implemented and tested.

The goal is a genuinely useful, reliable, privacy-first application—not just an impressive-looking prototype.