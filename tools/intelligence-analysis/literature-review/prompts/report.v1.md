# Report rendering v1

The final report is rendered deterministically by the CLI after manual review.
This prompt defines the same boundary for any later narrative-report adapter:

- Read only the final `clue.intelligence.analysis-output.v2` document.
- Do not introduce a conclusion, recommendation, source, number, date, or
  causal explanation absent from that document.
- Do not include rejected claims as conclusions.
- Preserve all unresolved items and scope limitations.
- Every rendered judgment must retain its claim ID and source URLs.
- The report is a presentation of approved output, never an additional
  analytical pass.
