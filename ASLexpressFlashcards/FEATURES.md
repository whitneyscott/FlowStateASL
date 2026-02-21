# ASL Express Flashcards — Features & User Guide

A comprehensive ASL (American Sign Language) vocabulary learning system designed for integration with Canvas LMS. Here's what you can do with it.

---

## For Students

### 1. Interactive Vocabulary Flashcards

- **Study ASL vocabulary** with real video demonstrations from SproutVideo
- **Choose your deck** — Content is automatically filtered by course unit when launched from Canvas, or browse all available playlists when using standalone
- **English-first or ASL-first** — See the English word and recall the sign, or watch the sign and recall the English meaning

### 2. Three Learning Modes

| Mode | Best For | How It Works |
|------|----------|--------------|
| **Rehearsal** | Self-paced practice | See a prompt (English or video), reveal the answer, then mark yourself Correct or Incorrect |
| **Tutorial** | Learning new signs | Answers auto-advance after a set time so you can study at your own pace without clicking |
| **Screening** | Quick mastery check | Achieve a streak (3, 4, or 5 correct in a row) to demonstrate mastery; get prompted to switch to Tutorial if you're struggling |

### 3. Typing Mode (ASL-First Only)

- When showing the ASL video first, enable **"Type answers"** to practice receptive skills
- Type the English equivalent and submit; get immediate feedback
- Useful for exam-style practice and spelling reinforcement

### 4. Flexible Study Options

- **Timer** — Optional countdown bar before the answer is revealed (1–10 seconds)
- **Shuffle** — Randomize card order each session
- **Reset Deck** — Start the current deck over without losing progress tracking
- **Retry Missed Only** — At the end of a session, practice only the words you got wrong

### 5. Progress & Benchmarking

- **Live progress** — See correct/total and streaks (in Screening mode)
- **85% benchmark** — If you can no longer reach 85%, you’ll be prompted to switch to Tutorial
- **Save results** — Download a list of missed words for offline review

### 6. Timed Practice (Prompt Manager)

- **5-minute warm-up** — Configurable timer with prompts displayed for practice
- **Record yourself** — Use your camera to record yourself signing the vocabulary
- **Download video** — Save your recording and submit it to a Canvas assignment
- **Unit-specific prompts** — Prompts match the unit you’re studying when launched from flashcards

---

## For Instructors

### 1. Canvas Integration

- **LTI tools** — Add flashcards and the timed practice tool to Canvas course navigation
- **Module-aware content** — When students launch from a Canvas module, they see vocabulary for that unit only
- **Grade submission** — Scores can be sent back to the Canvas gradebook (when configured)

### 2. Prompt Manager (Timed Practice)

- **Custom prompts** — Write or paste prompts (e.g., vocabulary lists, instructions) for the warm-up phase
- **Rich text editor** — Format prompts for clarity
- **Per-assignment settings** — Configure timer length and prompts per Canvas assignment
- **Access control** — Teacher-only configuration; students see the prompts you set

### 3. Teacher Role Security

- Configuration options are restricted to teachers, teaching assistants, and administrators
- Students see only the study interface and prompts you provide

---

## For Administrators

### 1. Two-Tool Setup

- **ASLExpress Flashcards** — Vocabulary study tool (launch: `lti_launch.php`)
- **ASLExpress Prompt Manager** — Timed warm-up and recording tool (launch: `lti_timed_launch.php`)

### 2. Content Management

- **SproutVideo** — ASL video content is hosted and delivered via SproutVideo playlists
- **Canvas API** — Module names (e.g., "Unit 5.1") are mapped to playlist filters (e.g., "TWA.05.01")
- **Smart matching** — Supports multiple format variations for flexible content mapping

### 3. Optional Integrations

- **Cohere API** (via `ai_proxy.php`) — Document reranking
- **Hugging Face** (via `hf_proxy.php`) — Cross-encoder inference
- **Canvas API** — Grade submission and module navigation

---

## Quick Start Summary

| I want to… | Use this… |
|------------|-----------|
| Study vocabulary with video flashcards | Launch **ASLExpress Flashcards** from Canvas or open `flashcards.php` |
| Do a timed warm-up and record myself signing | Launch **ASLExpress Prompt Manager** from Canvas or open `timer.php` |
| Set prompts for timed practice | Open the Prompt Manager as a teacher and configure prompts |
| Browse decks without Canvas | Open `flashcards.php` directly — you’ll see all available playlists |
| Study a specific unit in Canvas | Launch flashcards from that unit’s module — content is auto-filtered |

---

## Technical Notes

- **LTI 1.1** — Current integration standard (LTI 1.3 migration planned)
- **Responsive design** — Works on desktop and mobile
- **Dark theme** — Optimized for extended study sessions
