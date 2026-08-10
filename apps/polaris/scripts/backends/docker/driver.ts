import type { BackendDriver } from "../types.js";
import { PolarisBackendDriver } from "../vault-runtime-adapter.js";

export class DockerDriver extends PolarisBackendDriver implements BackendDriver {
  constructor() {
    super("docker");
  }
}
