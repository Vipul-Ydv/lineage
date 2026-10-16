# Lineage

A company brain for an open-source project. Lineage puts a repository's people, pull requests, issues, reviews and files into a FalkorDB graph, and an AI agent answers questions like:

- Who should I ask about the execution plan code?
- Why were unique constraint inserts slow in 6.0.0, and who fixed it?
- Which parts of the code would we lose knowledge of if one person left?

Every answer shows the path through the graph that supports it, and code checks every person, PR and number in the answer against what the agent actually found.

The demo graph is [FalkorDB/FalkorDB](https://github.com/FalkorDB/FalkorDB) itself: 309 people, 1,428 pull requests, 1,783 issues and 3,398 files.

Built for Graph Hacks: Context for AI Agents (Track 3, Company Brain).

## Run it

```bash
docker run -d -p 6379:6379 falkordb/falkordb:latest
npm install && (cd web && npm install && npm run build)
npm run load                      # loads data/snapshot into FalkorDB
cp .env.example .env              # point AI_BASE_URL at any OpenAI-compatible model with tool calling
npm run start                     # http://localhost:8787
```

To pull fresh data: `npm run fetch -- FalkorDB/FalkorDB` (uses `gh auth token` or `GITHUB_TOKEN`), then `npm run load`.
