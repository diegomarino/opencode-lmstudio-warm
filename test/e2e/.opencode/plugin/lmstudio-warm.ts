// E2E fixture entrypoint for opencode's `.opencode/plugin/` auto-discovery.
// `verify.sh` runs opencode from this directory, so opencode discovers this file
// and loads the plugin straight from the repo's src/ — no build, no copy to keep
// in sync. The canonical source is four levels up at src/index.ts.
export * from "../../../../src/index.ts"
