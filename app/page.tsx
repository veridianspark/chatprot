"use client";

/**
 * What did I miss?
 * ---------------------------------------------------------------------------
 * A local-first triage tool for overwhelming unread chats.
 *
 *  - Summarises long unread threads (extractive: picks the lines that matter)
 *  - Flags important messages (asks, decisions, mentions, urgent wording)
 *  - Ranks by urgency into three tiers
 *  - Pulls out deadlines and times, with live countdowns
 *
 * PRIVACY: there is no fetch / XHR / WebSocket / analytics call anywhere in this
 * file. Parsing, scoring and summarising all run inside the browser tab, and the
 * chat text lives only in React state (it is never written to localStorage).
 * To lock this down further, add `connect-src 'none'` to your CSP.
 *
 * To upgrade the heuristics with a fully on-device LLM later, swap `analyze()`
 * for a call to WebLLM / Transformers.js (WebGPU / WASM) - same data shapes.
 *
 * Drop this in as `app/page.tsx`. Requires Tailwind CSS (default in Next.js).
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

type Tier = "now" | "soon" | "fyi";
type Tag = "urgent" | "action" | "question" | "decision" | "mention" | "deadline";
type Level = "passed" | "hot" | "warm" | "mild" | "calm";

interface Msg {
  id: number;
  ts: Date | null;
  author: string;
  text: string;
}

interface TimeRef {
  phrase: string;
  parts: string[];
  due: Date;
  kind: "deadline" | "event";
}

interface Scored extends Msg {
  idx: number; // position inside the unread list
  mine: boolean;
  score: number;
  tier: Tier;
  tags: Tag[];
  why: string[];
  refs: TimeRef[];
}

interface Summary {
  headline: string;
  topics: string[];
  keyLines: Scored[];
  people: [string, number][];
}

interface Analysis {
  total: number;
  markerUsed: boolean;
  unread: Scored[];
  tiers: Record<Tier, Scored[]>;
  upcoming: { ref: TimeRef; msg: Scored }[];
  passed: { ref: TimeRef; msg: Scored }[];
  summary: Summary;
  minutes: { all: number; key: number };
}

/* ========================================================================== */
/* Constants                                                                  */
/* ========================================================================== */

const TIER_META: Record<Tier, { title: string; hint: string; color: string; tint: string }> = {
  now: { title: "Needs you now", hint: "Urgent, direct, or time-boxed", color: "#D62839", tint: "#FBE9EB" },
  soon: { title: "Coming up", hint: "Worth handling today", color: "#E09F00", tint: "#FFF5D9" },
  fyi: { title: "Good to know", hint: "Context, no action needed", color: "#7C8C9B", tint: "#EEF2F5" },
};

const LEVEL_STYLE: Record<Level, string> = {
  passed: "bg-[#DCE3E9] text-[#44525F]",
  hot: "bg-[#D62839] text-white",
  warm: "bg-[#F2A900] text-[#101820]",
  mild: "bg-[#FBE3A4] text-[#101820]",
  calm: "bg-[#CBE7E4] text-[#0F4B48]",
};

const TAG_LABEL: Record<Tag, string> = {
  urgent: "Urgent",
  action: "Asks for something",
  question: "Question",
  decision: "Decision",
  mention: "Mentions you",
  deadline: "Has a time",
};

const STOP = new Set(
  (
    "about after again also always because been before being could does doing done each even from have here into " +
    "just like make more most much need only other over please really should since some still such than that their " +
    "them then there these they this those thanks thank very want were what when where which while will with would " +
    "your yours know think going what's don't can't https http www com okay yeah yes guys team everyone hello"
  ).split(" ")
);

/** Deterministic placeholder used until the real clock is read after mount. */
const EPOCH = new Date(0);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_IDX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH_RE =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

/* Chat line formats */
const WA =
  /^\[?(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?\]?\s*(?:[-–]\s*)?([^:]{1,40}?):\s([\s\S]*)$/i;
const BRACKET = /^\[(\d{1,2}):(\d{2})\s*([ap]m)?\]\s*([^:]{1,40}?):\s(.*)$/i;
const SIMPLE = /^(@?[\p{L}][\p{L}\p{N}_.'’ -]{0,30}):\s+(.+)$/u;
const MARKER = /^[-–—=*\s]*(unread|new messages?)(\s+(below|starts here|from here))?[-–—=*\s]*$/i;

/* Signal detectors */
const URGENT =
  /\b(urgent|asap|immediately|right away|critical|emergency|blocker|blocking|blocked|p0|sev ?[01]|outage|down|broken|failing|escalat\w*|time[- ]sensitive|important)\b/i;
const ACTION =
  /\b(please|pls|plz|can you|could you|would you|need (?:you|to)|make sure|don'?t forget|remember to|action item|to-?do|follow up|reply|respond|send|share|review|approve|confirm|sign|pay|book|submit|fill in|update)\b/i;
const DECISION = /\b(decide|decision|approve|approval|sign[- ]off|go\/no[- ]go|vote|confirm|finali[sz]e|let'?s go with|final call)\b/i;
const DEADLINE_WORDS = /\b(due|deadline|eod|cut-?off|last date|expires?|no later than)\b/i;
const DEADLINE_CUE =
  /\b(by|before|until|till|due|deadline|submit|deliver|send|ready|finish|complete|last date|cut-?off|expires?|eod|cob|no later than|need(?:ed)?)\b/i;
const EVENT_WORDS = /\b(meeting|call|sync|stand-?up|join|dinner|lunch|catch ?up|interview|demo|review|flight|train|offsite|session)\b/i;
const MONEY = /(₹|\$|€|£|\brs\.?|\binr|\busd)\s?\d|\b\d+\s?(?:k|lakh|crore)\b|\binvoice\b|\bpayment\b|\bbudget\b|\bdeposit\b/i;
const BROADCAST = /@(everyone|channel|here|all)\b/i;
const LOW =
  /^(ok(ay)?|k|thanks?( you)?|thx|ty|lol|haha+|hehe+|yes|yep|no|nope|done|cool|nice|great( work.*)?|noted|sure|joining|got it|<media omitted>|[\p{Extended_Pictographic}\s]+)[.! ]*$/iu;

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

function mkDate(d: number, mo: number, y: number, h: number, mi: number, ap?: string): Date | null {
  let day = d;
  let mon = mo;
  let year = y;
  if (year < 100) year += 2000;
  if (mon > 12 && day <= 12) [day, mon] = [mon, day]; // mm/dd/yyyy exports
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  let hh = h;
  if (ap) {
    const pm = ap.toLowerCase().startsWith("p");
    if (pm && hh < 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  const dt = new Date(year, mon - 1, day, hh, mi);
  return isNaN(dt.getTime()) ? null : dt;
}

function humanSpan(ms: number) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function humanLong(ms: number) {
  const h = ms / 36e5;
  if (h < 1) return "under an hour";
  if (h < 48) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
}

function relative(due: Date, now: Date): { label: string; level: Level } {
  const diff = due.getTime() - now.getTime();
  const hours = Math.abs(diff) / 36e5;
  if (diff < 0) return { label: `passed ${humanSpan(-diff)} ago`, level: "passed" };
  const level: Level = hours <= 6 ? "hot" : hours <= 24 ? "warm" : hours <= 72 ? "mild" : "calm";
  return { label: `in ${humanSpan(diff)}`, level };
}

const fmtDue = (d: Date) =>
  d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtMsgTime = (d: Date | null) =>
  d ? d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

/* ========================================================================== */
/* Parsing                                                                    */
/* ========================================================================== */

function parseChat(raw: string, now: Date): { msgs: Msg[]; marker: number | null } {
  const lines = raw.replace(/\r/g, "").split("\n");
  // If the export clearly has timestamps, "Name: text" lines are continuations, not new messages.
  const rich = lines.filter((l) => WA.test(l) || BRACKET.test(l)).length >= 2;
  const msgs: Msg[] = [];
  let marker: number | null = null;

  for (const line of lines) {
    if (MARKER.test(line.trim())) {
      marker = msgs.length;
      continue;
    }
    let author: string | null = null;
    let text = "";
    let ts: Date | null = null;

    let m = line.match(WA);
    if (m) {
      ts = mkDate(+m[1], +m[2], +m[3], +m[4], +m[5], m[6]);
      author = m[7].trim();
      text = m[8];
    } else if ((m = line.match(BRACKET))) {
      ts = mkDate(now.getDate(), now.getMonth() + 1, now.getFullYear(), +m[1], +m[2], m[3]);
      author = m[4].trim();
      text = m[5];
    } else if (!rich && (m = line.match(SIMPLE)) && m[1].trim().split(/\s+/).length <= 3) {
      author = m[1].trim();
      text = m[2];
    }

    if (author !== null) msgs.push({ id: msgs.length, ts, author, text: text.trim() });
    else if (msgs.length && line.trim()) msgs[msgs.length - 1].text += "\n" + line.trim();
  }
  return { msgs, marker };
}

/* ========================================================================== */
/* Deadline + time extraction                                                 */
/* ========================================================================== */

function extractRefs(text: string, base: Date): TimeRef[] {
  const baseDay = startOfDay(base);
  const cue = DEADLINE_CUE.test(text);
  const event = EVENT_WORDS.test(text);

  // Explicit clock time ("5pm", "10:30 am", "by 17:00")
  let time: { h: number; m: number; phrase: string } | null = null;
  const t1 = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const t2 = text.match(/\b(?:by|at|before|until|till)\s+(\d{1,2}):(\d{2})\b/i);
  if (t1) {
    let h = +t1[1];
    const mi = t1[2] ? +t1[2] : 0;
    const pm = t1[3].toLowerCase() === "pm";
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    if (h < 24 && mi < 60) time = { h, m: mi, phrase: t1[0].trim() };
  } else if (t2 && +t2[1] < 24 && +t2[2] < 60) {
    time = { h: +t2[1], m: +t2[2], phrase: t2[0].trim() };
  }

  const days: { phrase: string; day: Date; defH: number; strong?: boolean }[] = [];
  const direct: { phrase: string; due: Date }[] = [];
  let m: RegExpMatchArray | null;

  if ((m = text.match(/\b(eod|cob|end of (?:the )?day)\b/i))) days.push({ phrase: m[0], day: baseDay, defH: 18, strong: true });
  if ((m = text.match(/\b(tonight|this evening)\b/i))) days.push({ phrase: m[0], day: baseDay, defH: 21 });
  if ((m = text.match(/\bthis (?:morning|afternoon)\b/i)))
    days.push({ phrase: m[0], day: baseDay, defH: /morning/i.test(m[0]) ? 12 : 17 });
  if ((m = text.match(/\btoday\b/i))) days.push({ phrase: m[0], day: baseDay, defH: 23 });
  if ((m = text.match(/\btomorrow(?:\s+(morning|afternoon|evening|night))?\b/i))) {
    const part = (m[1] || "").toLowerCase();
    const hours: Record<string, number> = { morning: 11, afternoon: 16, evening: 20, night: 22 };
    days.push({ phrase: m[0], day: addDays(baseDay, 1), defH: hours[part] ?? 23 });
  }
  const wd = text.match(/\b(next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[2].toLowerCase());
    let delta = (target - baseDay.getDay() + 7) % 7 || 7;
    if (/next/i.test(wd[1] || "")) delta += 7;
    days.push({ phrase: wd[0], day: addDays(baseDay, delta), defH: 23 });
  }
  if ((m = text.match(/\b(eow|end of (?:the )?week)\b/i)))
    days.push({ phrase: m[0], day: addDays(baseDay, (5 - baseDay.getDay() + 7) % 7), defH: 18, strong: true });
  if ((m = text.match(/\b(eom|end of (?:the )?month)\b/i)))
    days.push({ phrase: m[0], day: new Date(baseDay.getFullYear(), baseDay.getMonth() + 1, 0), defH: 18, strong: true });
  if ((m = text.match(/\bnext week\b/i))) days.push({ phrase: m[0], day: addDays(baseDay, 7), defH: 23 });

  const rel = text.match(/\bin (\d+|an?|one|two|three|four|five|six|a couple of) (min(?:ute)?s?|hours?|hrs?|days?|weeks?)\b/i);
  if (rel) {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, "a couple of": 2 };
    const n = /^\d+$/.test(rel[1]) ? +rel[1] : words[rel[1].toLowerCase()] ?? 1;
    const u = rel[2].toLowerCase();
    const unit = u.startsWith("m") ? 6e4 : u.startsWith("h") ? 36e5 : u.startsWith("d") ? 864e5 : 6048e5;
    direct.push({ phrase: rel[0], due: new Date(base.getTime() + n * unit) });
  }

  const absDate = (day: number, monthName: string, year?: string): Date | null => {
    const mi = MONTH_IDX[monthName.slice(0, 3).toLowerCase()];
    if (mi === undefined || day < 1 || day > 31) return null;
    const y = year ? +year : baseDay.getFullYear();
    const d = new Date(y, mi, day);
    if (d.getMonth() !== mi) return null;
    if (!year && d.getTime() < baseDay.getTime() - 60 * 864e5) d.setFullYear(y + 1);
    return d;
  };
  const A = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4}))?`, "i"));
  const B = text.match(new RegExp(`\\b${MONTH_RE}\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "i"));
  const abs = A ? absDate(+A[1], A[2], A[3]) : B ? absDate(+B[2], B[1], B[3]) : null;
  if (abs) days.push({ phrase: (A ?? B)![0], day: abs, defH: 23 });

  const N = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (N && !/24\/7/.test(N[0]) && (cue || N[3])) {
    const d = mkDate(+N[1], +N[2], N[3] ? +N[3] : baseDay.getFullYear(), 0, 0);
    if (d) days.push({ phrase: N[0], day: d, defH: 23 });
  }

  if (!days.length && !direct.length && time && (cue || event)) days.push({ phrase: "", day: baseDay, defH: time.h });

  const refs: TimeRef[] = [];
  const seen = new Set<string>();

  for (const d of direct) {
    const kind = cue ? "deadline" : event ? "event" : null;
    if (!kind) continue;
    refs.push({ phrase: d.phrase, parts: [d.phrase], due: d.due, kind });
  }
  for (const d of days) {
    const key = d.day.toDateString();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = cue || d.strong ? "deadline" : event ? "event" : null;
    if (!kind) continue;
    const due = new Date(d.day);
    if (time) due.setHours(time.h, time.m, 0, 0);
    else due.setHours(d.defH, d.defH === 23 ? 59 : 0, 0, 0);
    const parts = [d.phrase, time?.phrase].filter((p): p is string => !!p);
    refs.push({ phrase: parts.join(" "), parts, due, kind });
  }
  return refs.sort((a, b) => a.due.getTime() - b.due.getTime()).slice(0, 2);
}

/* ========================================================================== */
/* Scoring                                                                    */
/* ========================================================================== */

function scoreMessages(msgs: Msg[], name: string, now: Date): Omit<Scored, "idx">[] {
  const tokens = name
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const nameRe = tokens.length ? new RegExp(`(?:@|\\b)(?:${tokens.map(esc).join("|")})\\b`, "i") : null;
  const isMine = (author: string) => {
    const words = author.toLowerCase().split(/\s+/);
    return words.includes("you") || words.includes("me") || tokens.some((t) => words.includes(t));
  };

  return msgs.map((m, i) => {
    const mine = isMine(m.author);
    const t = m.text;
    let score = 0;
    const tags = new Set<Tag>();
    const why: string[] = [];
    const add = (pts: number, tag?: Tag, reason?: string) => {
      score += pts;
      if (tag) tags.add(tag);
      if (reason && !why.includes(reason)) why.push(reason);
    };

    let refs: TimeRef[] = [];
    if (!mine && !LOW.test(t.trim())) {
      const mentioned = !!nameRe && nameRe.test(t);
      if (URGENT.test(t)) add(5, "urgent", "urgent wording");
      if (mentioned) add(2.5, "mention", "mentions you");
      else if (BROADCAST.test(t)) add(1.5, "mention", "addressed to everyone");
      if (ACTION.test(t)) add(1.5, "action", "asks for something");
      if (DECISION.test(t)) add(1.5, "decision", "needs a decision");
      if (t.includes("?")) {
        add(1, "question");
        if (mentioned) add(1.5, undefined, "asks you directly");
      }
      const prev = msgs[i - 1];
      if (prev && isMine(prev.author) && t.includes("?")) add(1, undefined, "replies to your message");
      if (DEADLINE_WORDS.test(t)) add(1.5);
      if (MONEY.test(t)) add(1, undefined, "involves money");
      if (/\b[A-Z]{4,}\b/.test(t)) add(0.5);
      if (/!{2,}/.test(t)) add(0.5);
      if (t.length > 220) add(0.5);

      refs = extractRefs(t, m.ts ?? now);
      if (refs.length) {
        const deadline = refs.some((r) => r.kind === "deadline");
        add(deadline ? 2 : 1, "deadline", deadline ? "has a deadline" : "has a time attached");
        let prox = 0;
        for (const r of refs) {
          const diff = r.due.getTime() - now.getTime();
          if (diff < 0) prox = Math.max(prox, diff > -72 * 36e5 ? 2 : 0);
          else if (diff <= 6 * 36e5) prox = Math.max(prox, 3);
          else if (diff <= 24 * 36e5) prox = Math.max(prox, 2);
          else if (diff <= 72 * 36e5) prox = Math.max(prox, 1);
        }
        if (prox >= 2) why.push(prox === 3 ? "due very soon" : "due within a day");
        score += prox;
      }
    }

    const tier: Tier = mine ? "fyi" : score >= 5.5 ? "now" : score >= 3 ? "soon" : "fyi";
    return { ...m, mine, score, tier, tags: Array.from(tags), why, refs };
  });
}

/* ========================================================================== */
/* Summary                                                                    */
/* ========================================================================== */

function tokenize(text: string, skip: Set<string>): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
    if (!STOP.has(w) && !skip.has(w)) out.add(w);
  }
  return Array.from(out);
}

function buildSummary(unread: Scored[], upcomingCount: number): Summary {
  const authorWords = new Set(unread.flatMap((m) => m.author.toLowerCase().split(/\s+/)));
  const freq = new Map<string, number>();
  const toks = unread.map((m) => tokenize(m.text, authorWords));
  toks.forEach((ts) => ts.forEach((t) => freq.set(t, (freq.get(t) ?? 0) + 1)));

  const topics = Array.from(freq.entries())
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);

  // Extractive key lines: frequent topic words + our priority score
  const ranked = unread
    .map((m, i) => {
      const ts = toks[i];
      const topicWeight = ts.reduce((s, t) => s + (freq.get(t) ?? 0), 0) / Math.sqrt(ts.length + 4);
      return { m, ts, s: m.mine || m.text.length < 25 ? -1 : topicWeight + m.score * 0.8 };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const chosen: typeof ranked = [];
  for (const c of ranked) {
    if (chosen.length >= 4) break;
    const dup = chosen.some((k) => {
      const overlap = c.ts.filter((t) => k.ts.includes(t)).length;
      return overlap / Math.max(1, Math.min(c.ts.length, k.ts.length)) > 0.6;
    });
    if (!dup) chosen.push(c);
  }
  const keyLines = chosen.map((c) => c.m).sort((a, b) => a.id - b.id);

  const counts = new Map<string, number>();
  unread.forEach((m) => counts.set(m.author, (counts.get(m.author) ?? 0) + 1));
  const people = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);

  const stamped = unread.filter((m) => m.ts);
  const span =
    stamped.length > 1
      ? ` over ${humanLong(stamped[stamped.length - 1].ts!.getTime() - stamped[0].ts!.getTime())}`
      : "";
  const asks = unread.filter((m) => !m.mine && m.tags.includes("action")).length;
  const mentions = unread.filter((m) => !m.mine && m.tags.includes("mention")).length;
  const bits = [
    asks ? `${asks} ask${asks === 1 ? "s" : ""} for something` : "",
    upcomingCount ? `${upcomingCount} upcoming time${upcomingCount === 1 ? "" : "s"}` : "",
    mentions ? `${mentions} mention${mentions === 1 ? "" : "s"} of you or everyone` : "",
  ].filter(Boolean);

  const headline =
    `${unread.length} message${unread.length === 1 ? "" : "s"} from ${people.length} ${people.length === 1 ? "person" : "people"}${span}.` +
    (bits.length ? ` ${bits.join(", ")}.` : " Nothing here asks anything of you.");

  return { headline, topics, keyLines, people };
}

/* ========================================================================== */
/* Orchestration                                                              */
/* ========================================================================== */

function analyze(raw: string, name: string, lastN: string, now: Date): Analysis | null {
  const { msgs, marker } = parseChat(raw, now);
  if (!msgs.length) return null;

  let start = 0;
  let markerUsed = false;
  if (marker !== null) {
    start = marker;
    markerUsed = true;
  } else if (lastN !== "all") {
    start = Math.max(0, msgs.length - Number(lastN));
  }

  const unread: Scored[] = scoreMessages(msgs, name, now)
    .slice(start)
    .map((m, idx) => ({ ...m, idx }));

  const tiers: Record<Tier, Scored[]> = { now: [], soon: [], fyi: [] };
  for (const m of unread) if (!m.mine) tiers[m.tier].push(m);
  tiers.now.sort((a, b) => b.score - a.score);
  tiers.soon.sort((a, b) => b.score - a.score);

  const all = unread.filter((m) => !m.mine).flatMap((msg) => msg.refs.map((ref) => ({ ref, msg })));
  const t = now.getTime();
  const upcoming = all.filter((x) => x.ref.due.getTime() >= t).sort((a, b) => a.ref.due.getTime() - b.ref.due.getTime());
  const passed = all
    .filter((x) => x.ref.due.getTime() < t)
    .sort((a, b) => b.ref.due.getTime() - a.ref.due.getTime())
    .slice(0, 3);

  // Reading-time estimate: ~230 words a minute plus ~2s of overhead per message
  const secs = (m: Scored) => m.text.split(/\s+/).filter(Boolean).length / 3.8 + 2;
  const minutes = {
    all: unread.reduce((s, m) => s + secs(m), 0) / 60,
    key: [...tiers.now, ...tiers.soon].reduce((s, m) => s + secs(m), 0) / 60,
  };

  return {
    total: msgs.length,
    markerUsed,
    unread,
    tiers,
    upcoming,
    passed,
    summary: buildSummary(unread, upcoming.length),
    minutes,
  };
}

function summaryText(a: Analysis, now: Date): string {
  const out = [a.summary.headline, ""];
  if (a.tiers.now.length) {
    out.push("Needs you now:");
    a.tiers.now.slice(0, 8).forEach((m) => out.push(`- ${m.author}: ${clip(m.text, 140)}`));
    out.push("");
  }
  if (a.upcoming.length) {
    out.push("Deadlines and times:");
    a.upcoming.slice(0, 8).forEach(({ ref, msg }) =>
      out.push(`- ${fmtDue(ref.due)} (${relative(ref.due, now).label}) ${msg.author}: ${clip(msg.text, 100)}`)
    );
  }
  return out.join("\n").trim();
}

/* ========================================================================== */
/* Sample data (timestamps are relative to today so the demo always feels live) */
/* ========================================================================== */

function buildSample(): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const at = (daysAgo: number, h: number, m: number) => {
    const d = addDays(new Date(), -daysAgo);
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}, ${p(h)}:${p(m)} -`;
  };
  const depositDate = addDays(new Date(), 6);
  const dep = `${depositDate.getDate()} ${depositDate.toLocaleString("en", { month: "short" })}`;
  return [
    `${at(1, 10, 2)} Rahul: Morning all! Heads up, the client demo is moved to Friday 4pm.`,
    `${at(1, 10, 5)} Meera: lol nice`,
    `${at(1, 10, 11)} Sam: Anyone seen the new logo files?`,
    `${at(1, 10, 14)} Meera: They're in the shared drive under /brand`,
    `${at(1, 10, 30)} Dev: Staging is flaky again, deploys have been failing since last night`,
    `${at(1, 10, 41)} Dev: @Priya can you look at the payment webhook tests? They're blocking the release`,
    `${at(1, 11, 20)} Priya: On it, will check after lunch`,
    `${at(1, 15, 45)} Rahul: Reminder: expense reports are due by EOD tomorrow. Finance won't extend this time.`,
    `${at(1, 16, 10)} Sam: Also, are we still ordering lunch for the offsite?`,
    `${at(1, 18, 30)} Meera: Thanks!`,
    `${at(0, 8, 55)} Dev: URGENT: production checkout is down for some users, rolling back now`,
    `${at(0, 9, 2)} Dev: Priya need your sign-off on the rollback ASAP`,
    `${at(0, 9, 10)} Rahul: Can everyone join a call at 11am to figure out what happened?`,
    `${at(0, 9, 12)} Sam: Joining`,
    `${at(0, 9, 30)} Meera: The offsite venue needs a deposit of ₹25,000 by ${dep}. Can someone confirm the budget?`,
    `${at(0, 9, 45)} Sam: haha`,
    `${at(0, 9, 47)} Sam: ok`,
    `${at(0, 10, 5)} Rahul: @everyone please fill in your travel dates in the sheet before tomorrow evening`,
    `${at(0, 10, 20)} Dev: Rollback complete. Root cause looks like the config change in webhook retries.`,
    `${at(0, 10, 21)} Dev: I'll write the post-mortem and share it by Monday.`,
    `${at(0, 10, 22)} Meera: Great work team 🙌`,
  ].join("\n");
}

/* ========================================================================== */
/* Presentational pieces                                                       */
/* ========================================================================== */

function Highlighted({ text, phrases }: { text: string; phrases: string[] }) {
  const uniq = Array.from(new Set(phrases.filter((p) => p.trim().length >= 2))).sort((a, b) => b.length - a.length);
  if (!uniq.length) return <>{text}</>;
  const re = new RegExp(`(${uniq.map(esc).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-[#FFD866] px-0.5 font-medium text-inherit">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>
  );
}

function Rail({ unread, onJump }: { unread: Scored[]; onJump: (id: number) => void }) {
  const n = Math.min(unread.length, 90);
  const size = unread.length / n;
  const buckets = Array.from({ length: n }, (_, i) => {
    const from = Math.floor(i * size);
    const to = Math.max(Math.floor((i + 1) * size), from + 1);
    return unread.slice(from, to).reduce((a, b) => (b.score > a.score ? b : a));
  });
  return (
    <div>
      <div className="flex h-20 items-end gap-px" role="list" aria-label="Unread messages, oldest to newest, taller means more urgent">
        {buckets.map((b, i) => (
          <button
            key={i}
            role="listitem"
            type="button"
            disabled={b.mine}
            onClick={() => onJump(b.id)}
            aria-label={`${b.author}: ${clip(b.text, 60)}. ${TIER_META[b.tier].title}`}
            className="min-w-px flex-1 rounded-[1px] outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#101820] enabled:hover:opacity-70"
            style={{
              height: b.mine ? "10%" : `${14 + Math.min(b.score, 10) * 8.6}%`,
              background: b.mine ? "#C9D3DB" : TIER_META[b.tier].color,
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-[#5A6A78]">
        <span>Oldest</span>
        <span>Newest</span>
      </div>
    </div>
  );
}

function MessageRow({
  m,
  unread,
  done,
  later,
  open,
  flash,
  onToggleDone,
  onToggleOpen,
}: {
  m: Scored;
  unread: Scored[];
  done: boolean;
  later: boolean;
  open: boolean;
  flash: boolean;
  onToggleDone: () => void;
  onToggleOpen: () => void;
}) {
  const meta = TIER_META[m.tier];
  const phrases = m.refs.flatMap((r) => r.parts);
  const neighbours = open ? unread.slice(Math.max(0, m.idx - 2), m.idx + 3).filter((x) => x.id !== m.id) : [];
  return (
    <li
      id={`msg-${m.id}`}
      className={`scroll-mt-24 border-l-4 bg-white px-4 py-3 transition-opacity ${done ? "opacity-50" : ""} ${
        flash ? "outline outline-2 outline-offset-2 outline-[#101820]" : ""
      }`}
      style={{ borderColor: meta.color }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-sm">
          <span className="font-semibold">{m.author}</span>
          {m.ts && <span className="ml-2 text-[#5A6A78]">{fmtMsgTime(m.ts)}</span>}
          {later && <Chip className="ml-2 bg-[#FFE7A3] text-[#5B4100]">Saved for later</Chip>}
        </p>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[#44525F]">
          <input type="checkbox" checked={done} onChange={onToggleDone} className="h-4 w-4 accent-[#101820]" />
          Done
        </label>
      </div>
      <p className={`mt-1 whitespace-pre-wrap text-[15px] leading-6 ${done ? "line-through" : ""}`}>
        <Highlighted text={m.text} phrases={phrases} />
      </p>
      {(m.tags.length > 0 || m.why.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {m.tags.map((t) => (
            <Chip
              key={t}
              className={t === "urgent" ? "bg-[#D62839] text-white" : "bg-[#E3E9EE] text-[#2B3844]"}
            >
              {TAG_LABEL[t]}
            </Chip>
          ))}
          {m.why.length > 0 && <span className="text-xs text-[#5A6A78]">Flagged because: {m.why.join(", ")}</span>}
        </div>
      )}
      <button
        type="button"
        onClick={onToggleOpen}
        className="mt-2 text-xs font-medium text-[#1D5F73] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#101820]"
        aria-expanded={open}
      >
        {open ? "Hide surrounding messages" : "Show surrounding messages"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 border-t border-[#E3E9EE] pt-2 text-sm text-[#44525F]">
          {neighbours.map((n) => (
            <li key={n.id}>
              <span className="font-medium">{n.author}:</span> {clip(n.text, 160)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/* ========================================================================== */
/* Before/after counter, deadline rail, triage mode                           */
/* ========================================================================== */

type Decision = "done" | "later" | "skip";

const DECISION_HEX: Record<Decision, string> = { done: "#2BA39D", later: "#F2A900", skip: "#8B9BA9" };
const LEVEL_HEX: Record<Level, string> = {
  passed: "#9AA8B5",
  hot: "#D62839",
  warm: "#F2A900",
  mild: "#F7C948",
  calm: "#1D7874",
};

function BeforeAfter({ a }: { a: Analysis }) {
  const need = a.tiers.now.length + a.tiers.soon.length;
  const saved = a.minutes.all - a.minutes.key;
  const savedNum = saved < 1 ? "<1" : String(Math.round(saved));
  return (
    <div className="w-full max-w-2xl">
      <div className="grid grid-cols-3 text-white">
        <div className="bg-[#101820] p-4">
          <p className="font-serif text-4xl font-semibold leading-none sm:text-5xl">{a.unread.length}</p>
          <p className="mt-2 text-sm text-[#C5D0D9]">unread</p>
        </div>
        <div className="bg-[#D62839] p-4">
          <p className="font-serif text-4xl font-semibold leading-none sm:text-5xl">{need}</p>
          <p className="mt-2 text-sm text-white/90">need you</p>
        </div>
        <div className="bg-[#1D7874] p-4">
          <p className="font-serif text-4xl font-semibold leading-none sm:text-5xl">{savedNum}</p>
          <p className="mt-2 text-sm text-white/90">minutes saved</p>
        </div>
      </div>
      <p className="mt-1 text-xs text-[#5A6A78]">Reading time is estimated at about 230 words a minute.</p>
    </div>
  );
}

function DeadlineRail({
  items,
  now,
  onJump,
}: {
  items: { ref: TimeRef; msg: Scored }[];
  now: Date;
  onJump: (id: number) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  if (!items.length) return null;

  const DAY = 864e5;
  const maxDue = Math.max(...items.map((i) => i.ref.due.getTime()));
  const span = Math.min(7 * DAY, Math.max(DAY, maxDue - now.getTime()));

  // Stack pins that would overlap into separate rows
  const MAX_ROWS = 4;
  const lastPct: number[] = [];
  const pins = items.map((it, k) => {
    const pct = Math.min(100, Math.max(0, ((it.ref.due.getTime() - now.getTime()) / span) * 100));
    let row = lastPct.findIndex((l) => pct - l >= 5);
    if (row === -1) row = lastPct.length < MAX_ROWS ? lastPct.length : k % MAX_ROWS;
    lastPct[row] = pct;
    return { ...it, k, pct, row, level: relative(it.ref.due, now).level };
  });
  const rows = Math.max(...pins.map((p) => p.row)) + 1;
  const lineY = (rows - 1) * 26 + 22;
  const shown = active !== null ? pins[active] : null;

  return (
    <div className="mt-4">
      <div
        className="relative mx-3"
        style={{ height: lineY + 28 }}
        role="list"
        aria-label="Upcoming deadlines on a timeline from now to the latest deadline"
      >
        <div className="absolute left-0 right-0 h-0.5 bg-[#101820]" style={{ top: lineY }} />
        {[0, 25, 50, 75, 100].map((t) => (
          <div
            key={t}
            className="absolute whitespace-nowrap text-xs text-[#5A6A78]"
            style={{
              left: `${t}%`,
              top: lineY + 8,
              transform: t === 0 ? "none" : t === 100 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {t === 0 ? "Now" : `+${humanSpan((span * t) / 100)}`}
          </div>
        ))}
        {pins.map((p) => (
          <button
            key={`${p.msg.id}-${p.k}`}
            type="button"
            role="listitem"
            onClick={() => onJump(p.msg.id)}
            onMouseEnter={() => setActive(p.k)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(p.k)}
            onBlur={() => setActive(null)}
            aria-label={`${fmtDue(p.ref.due)}, ${relative(p.ref.due, now).label}. ${p.msg.author}: ${clip(p.msg.text, 60)}`}
            className="absolute flex flex-col items-center px-1 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#101820]"
            style={{ left: `${p.pct}%`, top: p.row * 26, transform: "translateX(-50%)" }}
          >
            <span
              className={`h-3.5 w-3.5 rounded-full border-2 border-white ${p.level === "hot" ? "motion-safe:animate-pulse" : ""}`}
              style={{ background: LEVEL_HEX[p.level] }}
            />
            <span className="w-px" style={{ height: (rows - 1 - p.row) * 26 + 8, background: LEVEL_HEX[p.level] }} />
          </button>
        ))}
      </div>
      <p className="mt-1 min-h-[1.5rem] text-sm text-[#33424F]">
        {shown ? (
          <>
            <span className="font-semibold">{fmtDue(shown.ref.due)}</span> {shown.msg.author}: {clip(shown.msg.text, 100)}
          </>
        ) : (
          <span className="text-[#5A6A78]">Hover or focus a pin to preview it. Click to jump to the message.</span>
        )}
      </p>
    </div>
  );
}

function TriageMode({
  queue,
  unread,
  now,
  onMark,
  onClose,
}: {
  queue: Scored[];
  unread: Scored[];
  now: Date;
  onMark: (id: number, d: Decision | null) => void;
  onClose: (jumpId?: number) => void;
}) {
  const [i, setI] = useState(0);
  const [dec, setDec] = useState<Record<number, Decision>>({});
  const root = useRef<HTMLDivElement>(null);
  const cur = i < queue.length ? queue[i] : null;

  const decide = (d: Decision) => {
    if (!cur) return;
    setDec((p) => ({ ...p, [cur.id]: d }));
    onMark(cur.id, d);
    setI(i + 1);
  };
  const undo = () => {
    if (i === 0) return;
    const prev = queue[i - 1];
    setDec((p) => {
      const n = { ...p };
      delete n[prev.id];
      return n;
    });
    onMark(prev.id, null);
    setI(i - 1);
  };

  // Focus the dialog and lock page scroll while it is open
  useEffect(() => {
    root.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Keyboard: D done, L later, S skip, U or left arrow to go back, Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "escape") onClose();
      else if (k === "d") decide("done");
      else if (k === "l") decide("later");
      else if (k === "s") decide("skip");
      else if (k === "u" || k === "arrowleft") undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const counts = { done: 0, later: 0, skip: 0 };
  Object.values(dec).forEach((d) => (counts[d] += 1));
  const meta = cur ? TIER_META[cur.tier] : null;
  const before = cur ? unread.slice(Math.max(0, cur.idx - 2), cur.idx) : [];
  const btn =
    "px-3 py-3 text-base font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

  return (
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Triage your messages one at a time"
      className="fixed inset-0 z-50 overflow-y-auto bg-[#101820] text-white outline-none"
    >
      <style>{`@keyframes triage-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:no-preference){.triage-card{animation:triage-in .2s ease-out}}`}</style>
      <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 py-6 sm:py-10">
        <div className="flex items-center justify-between gap-4">
          <p className="font-serif text-xl">{cur ? `Message ${i + 1} of ${queue.length}` : "Triage complete"}</p>
          <button
            type="button"
            onClick={() => onClose()}
            className="border border-white/40 px-3 py-1.5 text-sm font-medium hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            Close (Esc)
          </button>
        </div>

        <div className="mt-4 flex gap-1" aria-hidden="true">
          {queue.map((q, k) => (
            <div
              key={q.id}
              className="h-2 flex-1"
              style={{ background: dec[q.id] ? DECISION_HEX[dec[q.id]] : k === i ? "#FFFFFF" : "#364351" }}
            />
          ))}
        </div>

        {cur && meta ? (
          <>
            <div
              key={cur.id}
              className="triage-card mt-6 border-l-8 bg-white p-5 text-[#101820] sm:p-7"
              style={{ borderColor: meta.color }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: meta.tint }}>
                  {meta.title}
                </span>
                <span className="text-sm">
                  <span className="font-semibold">{cur.author}</span>
                  {cur.ts && <span className="ml-2 text-[#5A6A78]">{fmtMsgTime(cur.ts)}</span>}
                </span>
              </div>
              <p className="mt-4 whitespace-pre-wrap text-xl leading-8">
                <Highlighted text={cur.text} phrases={cur.refs.flatMap((r) => r.parts)} />
              </p>
              {cur.refs.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {cur.refs.map((r, k) => {
                    const rel = relative(r.due, now);
                    return (
                      <li key={k} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`rounded-sm px-2 py-1 font-semibold ${LEVEL_STYLE[rel.level]}`}>{rel.label}</span>
                        <span className="font-medium">{fmtDue(r.due)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {cur.why.length > 0 && (
                <p className="mt-4 text-sm text-[#44525F]">Flagged because: {cur.why.join(", ")}</p>
              )}
              {before.length > 0 && (
                <div className="mt-5 border-t border-[#E3E9EE] pt-3 text-sm text-[#5A6A78]">
                  <p className="font-medium text-[#44525F]">Just before this</p>
                  <ul className="mt-1 space-y-1">
                    {before.map((b) => (
                      <li key={b.id}>
                        <span className="font-medium">{b.author}:</span> {clip(b.text, 120)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="mt-6 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => decide("later")}
                className={`${btn} border border-white/50 hover:bg-white/10`}
              >
                Later (L)
              </button>
              <button
                type="button"
                onClick={() => decide("done")}
                className={`${btn} bg-[#2BA39D] text-[#04201F] hover:bg-[#35B8B1]`}
              >
                Done (D)
              </button>
              <button
                type="button"
                onClick={() => decide("skip")}
                className={`${btn} border border-white/50 hover:bg-white/10`}
              >
                Skip (S)
              </button>
            </div>
            <div className="mt-3 text-sm text-[#AFBCC7]">
              <button
                type="button"
                onClick={undo}
                disabled={i === 0}
                className="underline-offset-2 hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Go back one (U)
              </button>
            </div>
          </>
        ) : (
          <div className="triage-card mt-10">
            <h2 className="font-serif text-5xl font-semibold leading-tight">You&apos;re caught up</h2>
            <p className="mt-4 text-lg text-[#C5D0D9]">
              {counts.done} done, {counts.later} saved for later, {counts.skip} skipped.
            </p>
            {counts.later > 0 && (
              <div className="mt-6">
                <p className="text-sm font-semibold text-[#E5ECF1]">Saved for later</p>
                <ul className="mt-2 space-y-1">
                  {queue
                    .filter((q) => dec[q.id] === "later")
                    .map((q) => (
                      <li key={q.id}>
                        <button
                          type="button"
                          onClick={() => onClose(q.id)}
                          className="text-left text-[15px] text-[#C5D0D9] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                        >
                          <span className="font-medium text-white">{q.author}:</span> {clip(q.text, 100)}
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            <div className="mt-8 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onClose()}
                className="bg-white px-4 py-2.5 font-semibold text-[#101820] hover:bg-[#E3E9EE] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Back to results
              </button>
              <button
                type="button"
                onClick={undo}
                className="border border-white/50 px-4 py-2.5 font-medium hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Go back one (U)
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

export default function Page() {
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [lastN, setLastN] = useState("all");
  // Real clock is set after mount so the prerender never bakes in a stale `new Date()`.
  const [now, setNow] = useState<Date>(EPOCH);
  const [showFyi, setShowFyi] = useState(false);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [later, setLater] = useState<Set<number>>(new Set());
  const [triageQueue, setTriageQueue] = useState<Scored[] | null>(null);
  const [jump, setJump] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const deferredRaw = useDeferredValue(raw);
  useEffect(() => {
    setNow(new Date());
  }, []);

  const analysis = useMemo(
    () => (now === EPOCH ? null : analyze(deferredRaw, name, lastN, now)),
    [deferredRaw, name, lastN, now]
  );

  const toggle = (set: Set<number>, id: number, apply: (s: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  // Jump from the rail or a deadline to the message (expands "Good to know" if needed)
  useEffect(() => {
    if (jump === null || !analysis) return;
    const target = analysis.unread.find((m) => m.id === jump);
    if (target && !target.mine && target.tier === "fyi" && !showFyi) {
      setShowFyi(true);
      return;
    }
    const el = document.getElementById(`msg-${jump}`);
    setJump(null);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    setFlash(jump);
  }, [jump, showFyi, analysis]);

  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader(); // reads the file locally; nothing is uploaded
    reader.onload = () => {
      resetMarks();
      setRaw(String(reader.result ?? ""));
    };
    reader.readAsText(file);
  };

  const copySummary = async () => {
    if (!analysis) return;
    try {
      await navigator.clipboard.writeText(summaryText(analysis, now));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard may be blocked; ignore */
    }
  };

  // Forget per-chat marks (message ids restart for every new chat)
  const resetMarks = () => {
    setDone(new Set());
    setOpen(new Set());
    setLater(new Set());
    setShowFyi(false);
    setTriageQueue(null);
    setJump(null);
    setFlash(null);
  };

  const clearAll = () => {
    setRaw("");
    setName("");
    setLastN("all");
    setCopied(false);
    resetMarks();
  };

  const triageCandidates = analysis
    ? [...analysis.tiers.now, ...analysis.tiers.soon].filter((m) => !done.has(m.id))
    : [];

  const markFromTriage = (id: number, d: Decision | null) => {
    setDone((p) => {
      const n = new Set(p);
      if (d === "done") n.add(id);
      else n.delete(id);
      return n;
    });
    setLater((p) => {
      const n = new Set(p);
      if (d === "later") n.add(id);
      else n.delete(id);
      return n;
    });
  };

  const focusRing =
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#101820]";

  return (
    <main className="min-h-screen bg-[#E8EDF1] text-[#101820]">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-12">
        {/* Header */}
        <header className="max-w-2xl">
          <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">What did I miss?</h1>
          <p className="mt-3 text-lg text-[#33424F]">
            Paste a chat you haven&apos;t read. Get the few messages that need you, with deadlines pulled out.
          </p>
          <p className="mt-4 flex items-start gap-2 text-sm text-[#1D5F73]">
            <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span>
              Everything runs in this browser tab. Your chat is never uploaded, stored, or sent to an AI service.
            </span>
          </p>
        </header>

        <div className="mt-10 grid gap-10 lg:grid-cols-[340px_minmax(0,1fr)]">
          {/* Input column */}
          <section aria-label="Your chat" className="lg:sticky lg:top-6 lg:self-start">
            <label htmlFor="chat" className="text-sm font-semibold">
              Chat text
            </label>
            <textarea
              id="chat"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"Paste messages here.\n\nTip: add a line that says --- unread --- to mark where you stopped reading."}
              className={`mt-2 h-64 w-full resize-y border border-[#8DA0B0] bg-white p-3 text-sm leading-5 placeholder:text-[#6C7C8A] ${focusRing}`}
            />
            <div className="mt-2 flex flex-wrap gap-2 text-sm">
              <button
                type="button"
                onClick={() => {
                  resetMarks();
                  setRaw(buildSample());
                  setName("Priya");
                  setLastN("all");
                }}
                className={`bg-[#101820] px-3 py-1.5 font-medium text-white hover:bg-[#25323E] ${focusRing}`}
              >
                Try a sample chat
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className={`border border-[#101820] px-3 py-1.5 font-medium hover:bg-white ${focusRing}`}
              >
                Open a .txt export
              </button>
              {raw && (
                <button
                  type="button"
                  onClick={clearAll}
                  className={`px-3 py-1.5 font-medium text-[#44525F] underline-offset-2 hover:underline ${focusRing}`}
                >
                  Clear everything
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".txt,text/plain"
                className="hidden"
                onChange={(e) => {
                  onFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>

            <div className="mt-6 space-y-4">
              <div>
                <label htmlFor="name" className="text-sm font-semibold">
                  Your name in this chat
                </label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="So we can spot mentions of you"
                  className={`mt-1 w-full border border-[#8DA0B0] bg-white px-3 py-2 text-sm placeholder:text-[#6C7C8A] ${focusRing}`}
                />
              </div>
              <div>
                <label htmlFor="lastN" className="text-sm font-semibold">
                  How much is unread?
                </label>
                <select
                  id="lastN"
                  value={lastN}
                  onChange={(e) => setLastN(e.target.value)}
                  className={`mt-1 w-full border border-[#8DA0B0] bg-white px-3 py-2 text-sm ${focusRing}`}
                >
                  <option value="all">Everything I pasted</option>
                  <option value="25">Last 25 messages</option>
                  <option value="50">Last 50 messages</option>
                  <option value="100">Last 100 messages</option>
                  <option value="200">Last 200 messages</option>
                </select>
                {analysis?.markerUsed && (
                  <p className="mt-1 text-xs text-[#44525F]">Using your --- unread --- line instead.</p>
                )}
              </div>
            </div>
          </section>

          {/* Results column */}
          <section aria-live="polite" aria-label="Results" className="min-w-0">
            {!analysis ? (
              <div className="max-w-xl border-l-4 border-[#8DA0B0] bg-white p-5">
                <h2 className="font-serif text-2xl font-semibold">Nothing to read yet</h2>
                <p className="mt-2 text-[15px] leading-6 text-[#33424F]">
                  Paste a conversation on the left, or try the sample chat to see how it works.
                </p>
                <p className="mt-4 text-sm font-semibold">Getting a chat out of WhatsApp</p>
                <p className="mt-1 text-sm leading-6 text-[#44525F]">
                  Open the chat, choose More, then Export chat, then Without media. Open the .txt file here.
                </p>
                <p className="mt-4 text-sm font-semibold">Slack, Teams, Telegram, anything else</p>
                <p className="mt-1 text-sm leading-6 text-[#44525F]">
                  Select the messages, copy them, and paste. Lines like &quot;Name: message&quot; work.
                </p>
              </div>
            ) : analysis.unread.length === 0 ? (
              <div className="max-w-xl border-l-4 border-[#1D7874] bg-white p-5">
                <h2 className="font-serif text-2xl font-semibold">You&apos;re caught up</h2>
                <p className="mt-2 text-[15px] leading-6 text-[#33424F]">
                  There are no messages after your unread marker. Move the marker up, or choose a different unread range.
                </p>
              </div>
            ) : (
              <div className="space-y-10">
                {/* Catch-up */}
                <div>
                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <BeforeAfter a={analysis} />
                    <div className="flex flex-wrap gap-2">
                      {triageCandidates.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setTriageQueue(triageCandidates)}
                          className={`bg-[#101820] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#25323E] ${focusRing}`}
                        >
                          Start triage ({triageCandidates.length})
                        </button>
                      )}
                    <button
                      type="button"
                      onClick={copySummary}
                      className={`border border-[#101820] px-3 py-1.5 text-sm font-medium hover:bg-white ${focusRing}`}
                    >
                      {copied ? "Copied" : "Copy summary"}
                    </button>
                    </div>
                  </div>
                  <p className="mt-3 max-w-2xl text-[17px] leading-7">{analysis.summary.headline}</p>

                  <div className="mt-5">
                    <Rail unread={analysis.unread} onJump={setJump} />
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#44525F]">
                      {(Object.keys(TIER_META) as Tier[]).map((t) => (
                        <span key={t} className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5" style={{ background: TIER_META[t].color }} />
                          {TIER_META[t].title}
                        </span>
                      ))}
                    </div>
                  </div>

                  {analysis.summary.keyLines.length > 0 && (
                    <div className="mt-6 max-w-2xl">
                      <h2 className="font-serif text-xl font-semibold">The short version</h2>
                      <ul className="mt-2 space-y-2">
                        {analysis.summary.keyLines.map((m) => (
                          <li key={m.id} className="text-[15px] leading-6">
                            <button
                              type="button"
                              onClick={() => setJump(m.id)}
                              className={`text-left hover:underline ${focusRing}`}
                            >
                              <span className="font-semibold">{m.author}:</span> {clip(m.text, 170)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {analysis.summary.topics.length > 0 && (
                    <div className="mt-5 flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-sm text-[#44525F]">Mostly about</span>
                      {analysis.summary.topics.map((t) => (
                        <Chip key={t} className="bg-white text-[#2B3844]">
                          {t}
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>

                {/* Deadlines */}
                {(analysis.upcoming.length > 0 || analysis.passed.length > 0) && (
                  <div>
                    <h2 className="font-serif text-2xl font-semibold">Deadlines and times</h2>
                    <DeadlineRail items={analysis.upcoming} now={now} onJump={setJump} />
                    <ul className="mt-3 divide-y divide-[#D3DCE3] border-y border-[#D3DCE3]">
                      {[...analysis.upcoming, ...analysis.passed].map(({ ref, msg }, i) => {
                        const r = relative(ref.due, now);
                        return (
                          <li key={`${msg.id}-${i}`}>
                            <button
                              type="button"
                              onClick={() => setJump(msg.id)}
                              className={`flex w-full flex-wrap items-start gap-x-4 gap-y-1 py-3 text-left hover:bg-white/60 ${focusRing} ${
                                r.level === "passed" ? "opacity-70" : ""
                              }`}
                            >
                              <span className={`w-28 shrink-0 rounded-sm px-2 py-1 text-center text-sm font-semibold ${LEVEL_STYLE[r.level]}`}>
                                {r.label}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold">
                                  {fmtDue(ref.due)}
                                  <span className="ml-2 font-normal text-[#5A6A78]">
                                    {ref.kind === "deadline" ? "Deadline" : "Scheduled"}
                                  </span>
                                </span>
                                <span className="block text-sm text-[#33424F]">
                                  {msg.author}: {clip(msg.text, 110)}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="mt-2 text-xs text-[#5A6A78]">
                      Dates like &quot;Friday&quot; or &quot;tomorrow&quot; are worked out from when each message was sent. Check anything critical.
                    </p>
                  </div>
                )}

                {/* Tiers */}
                {(["now", "soon"] as Tier[]).map((tier) => {
                  const list = analysis.tiers[tier];
                  if (!list.length) return null;
                  const meta = TIER_META[tier];
                  return (
                    <div key={tier}>
                      <div className="flex items-baseline gap-3">
                        <h2 className="font-serif text-2xl font-semibold">{meta.title}</h2>
                        <span className="text-sm text-[#44525F]">
                          {list.length} · {meta.hint}
                        </span>
                      </div>
                      <ul className="mt-3 space-y-2">
                        {list.map((m) => (
                          <MessageRow
                            key={m.id}
                            m={m}
                            unread={analysis.unread}
                            done={done.has(m.id)}
                            later={later.has(m.id)}
                            open={open.has(m.id)}
                            flash={flash === m.id}
                            onToggleDone={() => toggle(done, m.id, setDone)}
                            onToggleOpen={() => toggle(open, m.id, setOpen)}
                          />
                        ))}
                      </ul>
                    </div>
                  );
                })}

                <div>
                  <div className="flex flex-wrap items-baseline gap-3">
                    <h2 className="font-serif text-2xl font-semibold">{TIER_META.fyi.title}</h2>
                    <span className="text-sm text-[#44525F]">
                      {analysis.tiers.fyi.length} · {TIER_META.fyi.hint}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowFyi((v) => !v)}
                      aria-expanded={showFyi}
                      className={`text-sm font-medium text-[#1D5F73] underline-offset-2 hover:underline ${focusRing}`}
                    >
                      {showFyi ? "Hide" : "Show"}
                    </button>
                  </div>
                  {showFyi && (
                    <ul className="mt-3 space-y-2">
                      {analysis.tiers.fyi.map((m) => (
                        <MessageRow
                          key={m.id}
                          m={m}
                          unread={analysis.unread}
                          done={done.has(m.id)}
                          later={later.has(m.id)}
                          open={open.has(m.id)}
                          flash={flash === m.id}
                          onToggleDone={() => toggle(done, m.id, setDone)}
                          onToggleOpen={() => toggle(open, m.id, setOpen)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
      {triageQueue && analysis && (
        <TriageMode
          queue={triageQueue}
          unread={analysis.unread}
          now={now}
          onMark={markFromTriage}
          onClose={(id) => {
            setTriageQueue(null);
            if (id !== undefined) setJump(id);
          }}
        />
      )}
    </main>
  );
}
