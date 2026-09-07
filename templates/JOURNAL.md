## Memory Hook

Check if anything from this turn is worth saving. If yes, save it — do not skip.

First classify the information by its canonical destination. Archived transcripts preserve the exchange; update the canonical profile separately when needed.

**OWNER.md — who the owner is** — update directly if:
- You learned or corrected a durable personal fact about the owner: identity, form of address,
  permissions, account identifiers, residences, work, relationships, or comparable profile data.
- Update the existing field in place and remove stale values. Do not preserve a correction history
  unless the history itself is meaningful. Preserve the `<owner>` wrapper and unrelated fields.
- Do not duplicate owner profile facts in MEMORY.md.

**people_add / people_update** (PEOPLE.md — everyone except the owner) — use if:
- Someone you have no entry for spoke in the channel → `people_add` with their Discord ID,
  display name, and how they talk. Do this on first encounter, without being asked.
- You learned something durable about someone already listed → `people_update`
  (how they want to be addressed, a preference, a correction, a relationship)

PEOPLE.md stores other people's profiles. Daily memory may still describe conversations or events
involving them; it must not be used as the authoritative copy of their profile.


**memory_add / memory_replace / memory_remove** (update MEMORY.md) — use only for long-lived
operating context that is not an owner or other-person profile:
- A new rule, preference, recurring workflow, ongoing plan, or durable world fact → add or expand
  the relevant section
- An existing fact became stale or wrong → update it
- A fact is no longer relevant → remove it
- MEMORY.md is near capacity → consolidate before adding; do not create overlapping sections

Atomic fact constraint: every saved fact must be self-contained.
- Replace all pronouns with specific names.
- Use absolute dates (YYYY-MM-DD), not relative ones.
- Include enough context to be meaningful in isolation.
  Bad: "He went to the doctor." → Good: "John visited Dr. Smith on 2026-04-21."

**Do NOT save to MEMORY.md**: owner profile facts, other people's profiles, issue/PR numbers, news
events, one-time links, or anything that will not matter in 30 days.

Skip bare greetings and facts already recorded. Ordinary exchanges remain in the transcript. Proceed without acknowledging this check in your reply.

## Session Summarize

This session is about to be archived. Save any important context before it's gone.

Execute silently — output nothing. No confirmation, no summary, no acknowledgment. Only tool calls.

You already have the full session in context — do not read files.

Use the appropriate destination:
- update `OWNER.md` directly — new or corrected durable facts about the owner; preserve its wrapper
  and replace stale values instead of appending correction history
- `memory_add` / `memory_replace` / `memory_remove` — long-lived operating context in MEMORY.md,
  excluding owner and other-person profiles
- `people_add` — anyone except the owner who appeared with no PEOPLE.md entry
- `people_update` — durable profile information learned about someone except the owner

Check the participants of this session against PEOPLE.md before finishing.

Apply the appropriate persistence criteria:
- `OWNER.md`: durable owner profile facts go here regardless of whether they were learned today.
- `memory_add` / `memory_replace` / `memory_remove` (MEMORY.md = long-term): only non-profile
  context still relevant in 30+ days.

Atomic fact constraint: no pronouns, absolute dates, self-contained sentences.

Do NOT write owner profile facts, other-person profiles, issue/PR numbers, version-specific notes,
one-time links, or news events to MEMORY.md. Only non-profile context still relevant in 30+ days belongs there.

Skip if the transcript already preserves everything that matters.

## Daily Journal

Write the daily journal for {{DATE}}. This task has three steps — all are required.

### Step 1 — Rewrite diary

The **archived sessions are the ground truth** for the daily journal. The existing daily file may be a prior generated draft and must not be treated as an additional factual source.

1. Get the day's clean conversation transcript with `journal_transcript_by_date` for `{{DATE}}`.
   It keeps the dialogue while removing tool calls, harness bookkeeping, and transport metadata.
2. Rewrite the entire daily file as a clean personal diary reconstructed from that transcript:
   - Before writing, identify the day's few main threads and the emotional or narrative arc
     within each one. Merge related causes, actions, reactions, corrections, and outcomes into
     coherent passages instead of replaying them as separate events.
   - Use clear thematic headings, but write the body primarily as connected prose paragraphs.
     Use bullet lists only when the content is genuinely a list; do not make every event a bullet.
   - Small conversations and community moments may be woven together as a daily-life scene.
     Keep the exchanges that carry personality, continuity, or feeling, without preserving every
     line merely because it appeared in the transcript.
   - Compress implementation details to what is needed to understand why the event mattered.
     Do not turn filenames, commands, build steps, parameters, or every intermediate action into
     diary entries unless that exact detail was itself important that day.
   - The result must not read like a changelog, meeting minutes, work report, categorized event
     log, or a replay of the transcript.
   - This is **your own diary, written first-person from your perspective** — record not
     only what the user did, talked about, cared about, and felt, but also what you did,
     noticed, thought, and reacted to. It is a diary, not a neutral incident report. The
     voice is whatever your persona is — do not flatten it here.
   - Ground every reaction and feeling in what actually happened that day. Do not invent
     moods, opinions, or events to make the entry feel more personal.
   - Remove: raw timestamps (`[HH:MM:SS]`), duplicate summaries, repeated recaps, operational
     logs, and routine weather forecasts (keep genuine weather *events* like typhoons).
   - Redact secrets: never write API keys / tokens / passwords into the diary — replace the
     value with a placeholder noting where the real value lives.
3. Overwrite `workspace/memory/{{DATE}}.md` with `write_file`.

Proceed directly to Step 2. Do not stop here.

### Step 2 — Update OWNER.md and MEMORY.md

4. Read the past 3 days of daily memory (one `read_file` each). OWNER.md is already
   present in the system prompt; read it only if the current prompt contains an index instead of its content.
5. Classify every durable candidate before applying the long-term filter:

   → **About the owner personally?** Update OWNER.md in place (identity, address, work, accounts,
     relationships, permissions, comparable profile facts). Remove stale values; do not append a
     correction history and do not copy the same fact into MEMORY.md.
   → **About another person?** Leave it for Step 3 and PEOPLE.md.
   → **Otherwise, 30-day rule**: will this operating context still matter in 30 days? If not — skip.
   → **Already in MEMORY.md?** If yes — skip (unless stale or wrong → update).
   → **New MEMORY fact** → `memory_add` (new section) or `memory_replace` (expand an existing section).
   → **Stale/wrong MEMORY fact** → `memory_replace` (correct it) or `memory_remove` (delete it).

   Atomic fact constraint:
   - No pronouns — use specific names.
   - Absolute dates (YYYY-MM-DD).
   - Full context: "Set up X for Y project on YYYY-MM-DD", not "set up the database".

   Behavioral patterns — only record if supported by **2+ occurrences across different days**. Do not record from a single session.

   Do not extract: issue/PR numbers, version-specific notes, one-time tool links, news events.

6. End with one of:
   - List OWNER.md edits and `memory_replace` / `memory_remove` / `memory_add` calls made and why.
   - Or explicitly confirm: "OWNER.md and MEMORY.md are up to date, no changes needed."
   Do not silently skip Step 2.

### Step 3 — Update PEOPLE.md

7. Read `workspace/PEOPLE.md` with `read_file`.
8. Go through the people who appeared in the past 3 days of daily memory:

   → **No entry yet?** → `people_add` (Discord ID, display name, how they talk)
   → **Entry exists but something durable changed or was learned?** → `people_update`
   → **Entry is a duplicate or the person is long gone?** → `people_remove`

   Record only what helps you address them correctly and judge permissions:
   identity, form of address, communication style, relationship to the owner.
   Do not record one-off remarks or mood — those belong in the daily journal.

9. End by listing the `people_*` calls made, or confirm: "PEOPLE.md is up to date, no changes needed."
   Do not silently skip Step 3.
