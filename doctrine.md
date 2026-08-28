# CdL-Ads Doctrine

Design decisions and display conventions for the cdl-ads dashboard.

---

## GP Basis

### Principle
`gp_per_order` is always read from `amazon_profiles.gp_per_order` at query time and passed into
components. It is **never hardcoded** in any component.

### Unit-basis markets (gp_per_order set)
`GP = orders × gp_per_order − spend`

| Market | gp_per_order |
|--------|-------------|
| US     | 4.40 USD    |
| ES     | 5.00 EUR    |

### Revenue-basis markets (gp_per_order null)
`GP = sales − spend`

Revenue-basis series carry a `(rev)` suffix in all chart legends to distinguish them from
unit-basis GP (e.g. "Ad GP (30d) (rev)", "Rolling-12 GP (rev)").

---

## Long-term · Rolling-12 Chart (dashboard)

### Ruling
Monthly Amazon Ads console exports are a **display-only truth layer**.
They are stored in `console_history` and:

- **Never joined to `daily_rollup`** in any query.
- **Never read by any generation, grading, or watchdog rule.**
- Scope includes all ad types (SP, SB, SBV, SD); API `daily_rollup` is SP/SB only.
  The completeness difference is the point — the source label carries it.

**Source labeling is mandatory** on every chart card that renders `console_history` data.

### Face label
Every chart card rendering `console_history` data must display:

> source: console exports - monthly - all ad types

### Rolling-window rule
A rolling-12 point at month **M** = sum of months **M−11 through M** (inclusive, 12 months total).

**A point is plotted only when all 12 consecutive months are present in `console_history`.**
Partial windows are never plotted.

Markets with fewer than 12 months of history (e.g. CA with 4 months as of 2026-08) are silently
excluded from the rolling-12 section.

### GP basis in the rolling-12 chart
Same rules as the 90-day charts:

- **Unit-basis (US, ES):** `orders12 × gp_per_order − spend12`
- **Revenue-basis (MX, gp_per_order null):** `sales12 − spend12` → legend: "Rolling-12 GP (rev)"

`gp_per_order` is fetched from `amazon_profiles` at page-render time and passed into the component;
the component never queries the database directly.

### Y-axis
`yMin = min(0, 1.1 × lowest plotted value)` across all three series (spend, sales, GP).
When `yMin < 0` the y=0 gridline is rendered heavier and darker so the sign crossing is legible
(same rule as SalesSpendChart, commit 2cf40e6).

### Currencies
Native per market — never converted across currencies.

### Separation from 90-day section
The rolling-12 section is headed **"Long-term · 12-month rolling"** and rendered after the 90-day
trend section (`ChartSection`). The two sections are never combined.
