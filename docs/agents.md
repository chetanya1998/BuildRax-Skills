# Agent integration

One skill (`packages/skills/skill/buildrax`) serves all agents. It only tells the agent which CLI
commands to run; no analysis happens inside the skill.

```bash
buildrax install-skill                 # project scope, all agents
buildrax install-skill --target claude --scope user
buildrax install-skill --dir <path>    # custom location: <path>/buildrax
buildrax install-skill --dry-run       # show destinations only
```

| Agent       | Project path              | User path                          |
| ----------- | ------------------------- | ---------------------------------- |
| Claude Code | `.claude/skills/buildrax` | `~/.claude/skills/buildrax`        |
| Codex       | `.agents/skills/buildrax` | `~/.agents/skills/buildrax`        |
| Antigravity | `.agents/skills/buildrax` | `~/.gemini/config/skills/buildrax` |

Codex and Antigravity share the project path, so one install serves both.

**Unverified:** these locations come from public guides and search summaries; the vendors'
official docs could not be read from the build environment. Older paths (`.codex/skills`,
`.agent/skills`, `~/.gemini/antigravity/skills`) may still work. Use `--dir` if a layout differs, and
confirm each agent actually lists the skill before relying on it.

The installer never overwrites a skill directory it did not create unless `--force` is given.
