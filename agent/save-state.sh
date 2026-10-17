#!/usr/bin/env bash
# Saves the agent's memory as the single commit on the agent-data branch (history never grows).
set -euo pipefail
[ -s state/agent.json ] || exit 0
export GIT_AUTHOR_NAME=first-in-agent GIT_AUTHOR_EMAIL=first-in-agent@users.noreply.github.com
export GIT_COMMITTER_NAME=first-in-agent GIT_COMMITTER_EMAIL=first-in-agent@users.noreply.github.com
blob=$(git hash-object -w state/agent.json)
tree=$(printf '100644 blob %s\tagent.json\n' "$blob" | git mktree)
commit=$(git commit-tree "$tree" -m "agent memory $(date -u +%FT%TZ)")
git push -q -f origin "$commit:refs/heads/agent-data"
