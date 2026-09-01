# Project Architecture Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one self-contained engineer-facing HTML+SVG diagram that explains the Herdr Agent Swarm runtime request loop, authority boundaries, durable recovery paths, and first-line production diagnostics.

**Architecture:** The artifact is one static document with inline CSS and SVG, plus the architecture-diagram template's pinned export scripts and three small export functions. The main SVG presents the durable request loop left to right; authority callouts, wake-up hints, recovery loops, a legend, and three operational cards provide the secondary reading paths.

**Tech Stack:** HTML5, inline SVG, CSS, browser JavaScript, html2canvas 1.4.1, jsPDF 2.5.2

**Spec:** `docs/superpowers/specs/2026-09-01-project-architecture-diagram-design.md`

## Global Constraints

- Create only `docs/herdr-agent-swarm-architecture.html`; do not modify service source or generated `dist/` output.
- Keep all CSS and SVG inline; only Google Fonts and the pinned html2canvas and jsPDF scripts may be external.
- Preserve the exact script versions, SRI hashes, `crossorigin="anonymous"`, `id="report-container"`, collapsed toolbar structure, and `copyAsImage()`, `downloadPNG()`, and `downloadPDF()` entry points from the architecture-diagram template.
- Present Lark as a visible delivery target, never as workflow authority.
- Distinguish durable business flow from best-effort wake-up hints.
- Do not imply automatic prompt replay after uncertain TraeX delivery.
- Keep the legend outside every architecture boundary.

---

### Task 1: Build the self-contained architecture artifact

**Files:**
- Create: `docs/herdr-agent-swarm-architecture.html`

**Interfaces:**
- Consumes: current behavior from `docs/architecture.md`, module names under `src/`, and the approved diagram spec
- Produces: a directly openable HTML document with `#report-container`, one inline SVG, `.toolbar`, `.toolbar-actions`, `.toolbar-toggle`, `copyAsImage(button)`, `downloadPNG(button)`, and `downloadPDF(button)`

- [ ] **Step 1: Establish the page shell and export contract**

  Add the HTML5 document, Chinese title/subtitle, inline dark-theme CSS, pinned Google Font and export scripts, report container, collapsed toolbar, diagram container, summary-card grid, and footer. Use a responsive `max-width` large enough for a `1440 × 980` SVG while retaining horizontal scrolling below desktop width.

- [ ] **Step 2: Draw the runtime request loop**

  Add an inline SVG with a slate grid, arrow markers, and arrows before component boxes. Draw these labeled stages from left to right: Lark inbound, durable SQLite acceptance, `InboundRouter`, `PromptRunWorkflow`, Herdr adapter, real Herdr pane plus TraeX, lifecycle projection, SQLite outbox, and CardKit delivery. Every semi-transparent component must have an opaque backing rectangle so connectors do not show through labels.

- [ ] **Step 3: Add authority, event-role, and recovery paths**

  Add four authority callouts for Herdr, exact TraeX JSONL transcript, SQLite, and user systemd. Expand SQLite into inbound, bindings, prompt/checkpoint, views, outbox, and lease areas. Use orange dashed paths only for Herdr socket/work scheduler wake-up hints. Add recovery components for periodic reconciliation, detached observation, startup convergence, and retry/dead-letter handling, with paths returning through authoritative observation and durable SQLite state.

- [ ] **Step 4: Add the incident index and export implementation**

  Add three summary cards for authority selection, stuck-request diagnosis, and invariants. Implement one shared capture helper using `getBoundingClientRect()` and `html2canvas(document.body, { x, y, width, height, scale: 2, backgroundColor: "#020617", ignoreElements })`; have the three entry points copy a PNG blob, download a PNG, or embed that PNG into a one-page jsPDF document. Exclude `.toolbar` from capture.

- [ ] **Step 5: Review the artifact against the approved spec**

  Compare every spec section against the finished page. Remove duplicated labels, keep all connector labels away from component text, confirm the legend begins below the lowest boundary, and make the page useful without fonts or export scripts loading.

- [ ] **Step 6: Commit the artifact**

  ```bash
  git add docs/herdr-agent-swarm-architecture.html
  git commit -m "docs: add project architecture diagram"
  ```

### Task 2: Verify structure, facts, and browser rendering

**Files:**
- Verify: `docs/herdr-agent-swarm-architecture.html`
- Reference: `docs/architecture.md`
- Reference: `src/coordinator/`
- Reference: `src/events/`

**Interfaces:**
- Consumes: the HTML artifact from Task 1
- Produces: reproducible command output and a desktop screenshot proving that the document is structurally complete and visually legible

- [ ] **Step 1: Run static structural assertions**

  Run a Node script that reads the HTML and exits nonzero unless it finds exactly one `<svg`, the report container, all three toolbar classes, both pinned script URLs and integrity hashes, all three export functions, no `<img`, no `foreignObject`, and all required architecture labels.

  ```bash
  node --input-type=module -e 'import { readFileSync } from "node:fs"; const h=readFileSync("docs/herdr-agent-swarm-architecture.html","utf8"); const required=["id=\"report-container\"","toolbar-actions","toolbar-toggle","html2canvas@1.4.1","jspdf@2.5.2","sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H","sha384-en/ztfPSRkGfME4KIm05joYXynqzUgbsG5nMrj/xEFAHXkeZfO3yMK8QQ+mP7p1/","function copyAsImage","function downloadPNG","function downloadPDF","InboundRouter","PromptRunWorkflow","HerdrRuntimeReconciler","ConversationViewProjector","LarkOutboxDispatcher"]; const failures=required.filter(x=>!h.includes(x)); if ((h.match(/<svg\b/g)||[]).length!==1) failures.push("exactly one svg"); if (/<img\b|<foreignObject\b/i.test(h)) failures.push("forbidden image or foreignObject"); if(failures.length){console.error(failures);process.exit(1)} console.log("architecture HTML structure passed")'
  ```

  Expected: `architecture HTML structure passed`.

- [ ] **Step 2: Run repository document checks**

  Run `git diff --check -- docs/herdr-agent-swarm-architecture.html` and `npm run docs:audit`.

  Expected: both commands exit 0 and the audit prints `Superpowers documentation archive audit passed.`

- [ ] **Step 3: Inspect a real desktop rendering**

  Serve the repository over loopback, open `docs/herdr-agent-swarm-architecture.html` at a desktop viewport, capture a full-page screenshot, and visually verify that no text or boxes overlap, the runtime loop reads left to right, dashed hint paths are distinct, and the legend is below the architecture boundaries.

- [ ] **Step 4: Verify source-backed terminology**

  Search `docs/architecture.md` and `src/` for the five workflow/projector names and the four authority claims shown in the artifact. Confirm that the diagram does not mention the retired compatibility plugin as a live surface and does not represent Lark cards as state authority.

- [ ] **Step 5: Re-run verification after the final visual edit**

  Repeat the static assertions, `git diff --check`, documentation audit, and browser screenshot after any layout change. Record the exact successful outputs in the handoff.
