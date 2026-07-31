# @paseo/embed

`@paseo/embed` embeds the standalone Paseo Web app into any browser-based
application without sharing its router, styles, or runtime state.

```ts
import { createPaseoEmbed } from "@paseo/embed";

const paseo = createPaseoEmbed({
  container: document.querySelector("#paseo-panel"),
  paseoUrl: "https://paseo.example/paseo",
  endpoint: "daemon.example:6767",
});

paseo.setContext({
  source: "host-app",
  kind: "record",
  id: "record-42",
  title: "Record 42",
  text: "The host application selected record 42.",
});

const { agentId } = await paseo.createWorkspace({
  path: "/workspace/project",
  defaultModel: {
    provider: "codex",
    model: "gpt-5.4",
    thinkingOptionId: "medium",
  },
});
```

The package owns the iframe, nonce, message-origin checks, and request queue.
Paseo Web must be hosted separately. For production, configure the Paseo embed
parent origin to match the host application origin.
