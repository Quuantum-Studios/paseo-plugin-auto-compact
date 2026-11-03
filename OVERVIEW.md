Keeps long-running Claude agents lean. Once an agent's context passes a threshold (150k tokens by default), the plugin asks the agent whether now is a good point to compact. If the agent says yes, it first saves its notes, learnings and skill updates to files, then the plugin compacts it and tells it to resume from those notes.

It is off until you switch **Enabled** on in its settings (sidebar top list **Auto-compact**, or Settings → Plugins). Settings cover the threshold, the risk and confidence the agent must report, cooldowns, and an `autocompact=off` label that excludes an agent. Two optional Command Center actions install a helper script, a skill and a Claude reminder hook; each backs up the files it changes.

The plugin reads each agent's context size and last reply and sends prompts to those agents, including `/compact`. It sends nothing elsewhere. It needs Paseo 0.14.0 or later and Claude agents.
