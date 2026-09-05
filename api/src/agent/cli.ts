// `npm run ask -- "How does creating a user work?"` — exercise the agent against the fixture
// (or a real repo with REPO=<path>) without the HTTP layer.
import "../env.js";
import { runDiscovery } from "../discovery-adapter.js";
import { indexGraph } from "../graph/query.js";
import { describeLLM, resolveModel } from "../llm.js";
import { ask } from "./agent.js";

const question = process.argv.slice(2).join(" ") || "How does creating a user work?";
const repo = process.env.REPO ?? null;

try {
  const { graph, source, rootDir } = await runDiscovery(repo ? { localPath: repo } : {});
  indexGraph(graph);
  const llm = await resolveModel();
  console.error(`[graph] ${source}: ${graph.stats.nodeCount} nodes, ${graph.stats.edgeCount} edges`);
  console.error(`[llm] ${llm.provider} / ${llm.model} (model: ${llm.modelSource})`);
  console.error(`[q] ${question}\n`);

  const t0 = Date.now();
  const res = await ask(question, { rootDir });
  console.log(res.answer);
  console.log(`\nanswered by: ${res.llm?.provider}/${res.llm?.model}`);
  console.log("citedNodeIds:", res.citedNodeIds);
  console.log("toolCalls:", res.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`));
  console.error(`\n${Date.now() - t0} ms`);
  process.exit(0);
} catch (e) {
  console.error(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  try {
    console.error(`[llm] ${JSON.stringify(describeLLM(await resolveModel()))}`);
  } catch { /* config itself may be the error */ }
  process.exit(1);
}
