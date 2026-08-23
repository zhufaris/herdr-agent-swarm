import { resolve } from "node:path";
import { loadConfig, validateProjectDirectories, validateProjectRegistryFile } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";

const environmentPath = process.argv[2];
if (!environmentPath) {
  process.stderr.write("usage: node dist/cli/validate-config.js <bridge.env> [projects.json]\n");
  process.exitCode = 2;
} else {
  try {
    const absoluteEnvironmentPath = resolve(environmentPath);
    const environment = readEnvironmentFile(absoluteEnvironmentPath);
    const projectPath = resolve(process.argv[3] ?? environment.PROJECTS_CONFIG_PATH ?? "");
    environment.PROJECTS_CONFIG_PATH = projectPath;
    validateProjectRegistryFile(projectPath);
    const config = loadConfig(environment);
    validateProjectDirectories(config.projects);
    process.stdout.write(JSON.stringify({
      status: "valid",
      projectCount: config.projects.length,
      workspaceCount: new Set(config.projects.map((project) => project.workspaceId)).size,
      http: config.http
    }) + "\n");
  } catch (error) {
    process.stderr.write(`configuration invalid: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
