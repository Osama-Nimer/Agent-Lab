# Discovery Engine Agent

> An AI agent that turns a software repository into a structured **Engineering Graph** and uses that graph to answer architecture and codebase questions.

## Overview

Large software repositories are difficult for AI agents to understand when they are treated as a collection of files.

**Discovery Engine Agent** takes a different approach:

```text
Repository
    │
    ▼
Deterministic Discovery
    │
    ▼
Engineering Graph
    │
    ▼
Graph-aware Agent
    │
    ▼
Architecture Answers
```

The core idea is simple:

> **A codebase should be represented as a structured engineering graph before an agent reasons about it.**

The system scans a repository, discovers modules, routes, functions, models, calls, imports, and relationships, then converts those findings into a graph. The agent can query that graph instead of repeatedly searching through raw source files.

## What It Can Do

### 1. Analyze a repository

The API accepts either a local repository path or a GitHub repository URL.

```text
POST /api/analyze
```

The discovery pipeline performs deterministic source analysis and produces a graph containing nodes and edges.

### 2. Build an Engineering Graph

The graph represents relationships inside the codebase, such as:

- Files
- Modules
- Functions
- Routes
- Models
- Imports
- Function calls
- Module relationships
- Other discovered engineering entities

Every discovered relationship keeps source information so the agent can trace an answer back to the code.

### 3. Ask architecture questions

After a graph is loaded, questions can be sent to the agent:

```text
POST /api/ask
```

Examples:

```text
How does creating a course work?

What depends on the enrollments model?

Show me the authentication architecture.

What modules are connected to the users module?
```

The agent uses graph tools to explore the repository and returns an answer with references to discovered nodes.

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│                     Web Interface                       │
│                  Next.js + React Flow                   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Express API                          │
│                                                         │
│  /api/analyze     /api/graph     /api/ask     /health  │
└───────────────┬─────────────────────────────┬───────────┘
                │                             │
                ▼                             ▼
┌──────────────────────────┐      ┌────────────────────────┐
│  Discovery Engine        │      │  Graph-aware Agent      │
│                          │      │                        │
│  • AST analysis          │      │  • Graph tools          │
│  • Routes                │      │  • Neighbor traversal   │
│  • Modules               │      │  • Path tracing         │
│  • Calls                 │      │  • File inspection       │
│  • Models                │      │  • LLM reasoning        │
└────────────┬─────────────┘      └───────────┬────────────┘
             │                                │
             └──────────────┬─────────────────┘
                            ▼
                 ┌──────────────────────┐
                 │ Engineering Graph   │
                 │                      │
                 │ Nodes + Edges        │
                 │ Source locations     │
                 │ Relationships        │
                 └──────────────────────┘
```

## Repository Structure

```text
Discovery-Engine-Agent/
├── Docs/
│   ├── ARCHITECTURE.md
│   ├── CONTRACTS.md
│   ├── EXECUTION_PLAN.md
│   ├── FIXTURE_SAMPLE.md
│   ├── SETUP.md
│   └── lanes/
│       ├── LANE_A_DISCOVERY.md
│       ├── LANE_B_GRAPH_AGENT.md
│       └── LANE_C_UI.md
│
├── api/
│   ├── src/
│   │   ├── agent/          # Agent and graph-aware tools
│   │   ├── discovery/      # Deterministic repository discovery
│   │   ├── graph/          # Graph construction and queries
│   │   ├── clone.ts        # Repository cloning
│   │   ├── contract.ts     # Shared API/data contracts
│   │   └── server.ts       # Express API
│   └── package.json
│
├── fixtures/               # Sample/runtime graph data
│
└── web/                    # Next.js visualization UI
```

## Tech Stack

### Backend

- TypeScript
- Node.js
- Express 5
- `ts-morph` for TypeScript AST analysis
- `fast-glob` for source discovery
- `simple-git` for repository cloning
- Graphology for graph representation and traversal
- OpenAI Agents SDK for the agent layer
- Zod for validation

### Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- React Flow (`@xyflow/react`)
- Dagre for graph layout

### LLM

The agent uses an OpenAI-compatible interface, allowing different providers to be configured through environment variables.

## Quick Start

### Prerequisites

- Node.js 20+
- npm
- Git
- An API key for an OpenAI-compatible LLM provider if you want to use `/api/ask`

### 1. Clone the repository

```bash
git clone https://github.com/Osama-Nimer/Discovery-Engine-Agent.git
cd Discovery-Engine-Agent
```

### 2. Install the API dependencies

```bash
cd api
npm install
```

### 3. Configure environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

For example, you can configure Groq:

```env
GROQ_API_KEY=your_key_here
PORT=3001
CLONE_DIR=./.tmp-repos
```

See [`Docs/SETUP.md`](Docs/SETUP.md) for the complete provider configuration.

### 4. Start the API

```bash
npm run dev
```

The API runs on:

```text
http://localhost:3001
```

### 5. Start the web application

In another terminal:

```bash
cd web
npm install
npm run dev
```

The web application runs on:

```text
http://localhost:3000
```

## API

### Health

```http
GET /api/health
```

Returns API, graph, and LLM configuration status.

### Analyze a repository

Local repository:

```json
{
  "localPath": "/path/to/repository"
}
```

GitHub repository:

```json
{
  "repoUrl": "https://github.com/owner/repository"
}
```

Endpoint:

```http
POST /api/analyze
```

### Load the sample graph

```http
POST /api/analyze/sample
```

Useful for testing the UI without analyzing another repository.

### Get the current graph

```http
GET /api/graph
```

### Ask the agent

```http
POST /api/ask
```

Request:

```json
{
  "question": "How does authentication work?"
}
```

The agent explores the loaded graph using its tools before generating an answer.

## CLI

The API package also exposes development CLIs:

```bash
# Discover a repository
npm run discover

# Ask the agent from the command line
npm run ask

# Run graph self-tests
npm run test:graph

# Run agent self-tests
npm run test:agent

# Run all tests
npm test
```

## Demo Flow

The intended demo is:

1. Open the web application.
2. Provide a repository path or GitHub repository URL.
3. Run the analysis.
4. Inspect the generated Engineering Graph.
5. Ask an architecture question.
6. Watch the agent query the graph.
7. Receive an answer grounded in the repository structure.

For the current development demo, the project documentation uses **MentoraJo-backend** as the primary example repository.

## Why the Graph Matters

A conventional coding agent often works like this:

```text
Question
   ↓
Search files
   ↓
Read chunks
   ↓
Guess relationships
   ↓
Answer
```

Discovery Engine Agent aims for:

```text
Repository
   ↓
Parse structure
   ↓
Build graph
   ↓
Traverse relationships
   ↓
Inspect relevant source
   ↓
Answer
```

This separates **discovery** from **reasoning**.

The graph is not generated by the LLM. Repository discovery is deterministic, and discovered edges retain source locations. The LLM is used for reasoning over the resulting structure rather than inventing the structure itself.

## Current Scope

This repository is a prototype/demo focused on proving the Engineering Graph approach.

It is **not** intended to be a complete universal code intelligence platform yet.

Current focus:

- Repository discovery
- Engineering graph construction
- Graph querying
- Agent reasoning over the graph
- Architecture visualization
- A small, demonstrable end-to-end workflow

## Documentation

Detailed project documentation is available in [`Docs/`](Docs/):

- [`ARCHITECTURE.md`](Docs/ARCHITECTURE.md) — system design and engineering graph model
- [`CONTRACTS.md`](Docs/CONTRACTS.md) — shared interfaces and data contracts
- [`EXECUTION_PLAN.md`](Docs/EXECUTION_PLAN.md) — implementation plan and demo workflow
- [`SETUP.md`](Docs/SETUP.md) — environment, dependencies, and commands
- [`FIXTURE_SAMPLE.md`](Docs/FIXTURE_SAMPLE.md) — example graph fixture

## Project Status

**Prototype / Demo**

The end-to-end pipeline is implemented:

```text
Repository → Discovery → Engineering Graph → Agent → Answer
```

The project is still under active experimentation, and the discovery rules and graph model are expected to evolve as more repository patterns are supported.

## Core Principle

> **Don't ask an AI agent to understand a repository from files alone. Give it a map of the repository first.**

## License

This project is currently an experimental prototype. See the repository for licensing information.