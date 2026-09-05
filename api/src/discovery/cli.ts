import { discover } from "./index.js";

const root = process.argv[2];
if (!root) {
  console.error("usage: tsx src/discovery/cli.ts <repo-path>");
  process.exit(1);
}

const facts = await discover(root);
console.log(JSON.stringify(facts, null, 2));
console.error(
  `\n${facts.nodes.length} nodes, ${facts.edges.length} edges, ${facts.stats.warnings.length} warnings`
);
