# System

**System is a cognitive control plane for a society of agents.**

It turns a user goal into controlled, evidence-driven work by planning semantic
workflow, selecting capable Workers, organizing persistent Teams, managing
Artifacts and Evidence, enforcing Authority, and recovering failed execution.

System is an architectural successor to ideas proven in
[`@tsuuanmi/internet`](https://github.com/tsuuanmi/internet) and
[`AgentOS`](https://github.com/tsuuanmi/AgentOS). It is not a compatibility
layer or a mechanical merge of those repositories.

The central idea is simple:

> **Models reason. System decides whether a state transition is valid.**

## Mental model

```text
User goal
   |
   v
System
  |-- cognitive policy
  |    |-- goal interpretation
  |    |-- planning
  |    `-- procedure selection
  |
  |-- deterministic control
  |    |-- workflow/task graph
  |    |-- artifact/evidence graph
  |    |-- acceptance
  |    |-- authority
  |    `-- recovery
  |
  `-- execution
       |-- Workers
       |-- Teams
       `-- Capabilities
            |-- Website
            |-- GitHub
            |-- filesystem/shell
            `-- MCP/native tools
```

Agents are important computational actors, but they are not the center of the
architecture. System is responsible for composing intelligence toward a goal.

## Documentation

Start with [`docs/README.md`](docs/README.md).

- [Architecture](docs/architecture/README.md)
- [Philosophy](docs/architecture/philosophy.md)
- [MVP requirements](docs/requirements/mvp.md)
- [Documentation architecture](docs/governance/documentation-architecture.md)

The initial repository is deliberately docs-first. Implementation follows only
after these semantic boundaries are accepted.
