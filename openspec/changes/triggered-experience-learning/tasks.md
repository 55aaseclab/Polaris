## 1. Trigger And Lesson Model

- [x] 1.1 Add explicit trigger parsing for `POLARIS-LEARN-IT`, `POLARIS-RECALL`, `POLARIS-DONT-LEARN`, and `POLARIS-EPHEMERAL` in the evolution observer/runtime path
- [x] 1.2 Introduce a structured lesson artifact schema with title, summary, when-to-use guidance, tags, scope, source metadata, and confidence
- [x] 1.3 Update runtime artifact rendering so retrieved context is lesson-oriented rather than generic playbook-only summaries

## 2. Selective Summarization

- [x] 2.1 Add a cheap summarizer integration that is invoked only for explicit learn-triggered runs and meaningful success/failure events
- [x] 2.2 Add a deterministic fallback summarization path when the cheap summarizer is unavailable or disabled
- [x] 2.3 Add conservative policy rules so user-issued triggers are trusted first and routine runs do not automatically incur summarization cost

## 3. Shared Daemon Recall Path

- [x] 3.1 Keep daemon-owned `appendSystemPrompt` as the shared recall surface and update the observer to patch it using supported Paseo daemon config APIs
- [x] 3.2 Ensure the shared appended prompt remains short, bounded, and derived from the top relevant lessons only
- [x] 3.3 Verify that both CLI-created and web-portal-created Paseo runs receive the same refreshed lesson context through the daemon path

## 4. Verification And Documentation

- [x] 4.1 Add tests for trigger detection, selective summarization policy, lesson artifact persistence, and shared appended prompt refresh
- [x] 4.2 Add tests or fixtures that prove daemon-observed runs produce lessons without requiring entrypoint-specific wrappers
- [x] 4.3 Update evolution documentation to describe the lesson-only model, trigger vocabulary, and cheap-model summarization strategy
